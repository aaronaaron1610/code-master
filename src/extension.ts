import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { Agent } from './services/agent';
import { streamChat, ChatMessage, Attachment, ChatMessageContentPart, getMessageTextContent, constructPromptWithFiles } from './services/llm';

export function activate(context: vscode.ExtensionContext) {
  const agent = new Agent();
  const provider = new CodeMasterChatViewProvider(context, agent);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'code-master.chatView',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Command to reset conversations from global controls
  context.subscriptions.push(
    vscode.commands.registerCommand('code-master.resetChat', () => {
      provider.resetConversation();
    })
  );

  // Auto-push workspace path when workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.syncWorkspace();
    })
  );
}

export function deactivate() {}

class CodeMasterChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private chatMessages: ChatMessage[] = [];
  private currentProvider: string = 'OpenRouter';
  private currentModel: string = 'google/gemini-2.5-flash';
  private currentMode: 'chat' | 'agent' = 'agent';
  private currentThinkingEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' = 'medium';
  private activeAbortController?: AbortController;
  private openRouterModels: any[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agent: Agent
  ) {}

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Watch dist/webview/assets for changes to auto-refresh in development
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.context.extensionUri, 'dist/webview/assets/*')
    );
    
    const changeListener = () => {
      if (this._view) {
        this._view.webview.html = this.getHtmlForWebview(this._view.webview);
      }
    };
    
    watcher.onDidChange(changeListener);
    watcher.onDidCreate(changeListener);

    // Watch architecture file (located in .cm_reports directory)
    const archWatcher = vscode.workspace.createFileSystemWatcher(
      '**/.cm_reports/{ARCHITECTURE,architecture}.md'
    );
    
    const checkArchFile = () => {
      this.postMessageToWebview({
        type: 'architectureState',
        exists: this.doesArchitectureFileExist()
      });
    };

    archWatcher.onDidCreate(checkArchFile);
    archWatcher.onDidChange(checkArchFile);
    archWatcher.onDidDelete(checkArchFile);
    
    webviewView.onDidDispose(() => {
      watcher.dispose();
      archWatcher.dispose();
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'ready':
          await this.sendInitialState();
          break;
        case 'saveKeys':
          await this.saveApiKeys();
          break;
        case 'updateModel':
          this.currentModel = data.model;
          this.currentProvider = 'OpenRouter';
          break;
        case 'updateThinkingEffort':
          this.currentThinkingEffort = data.thinkingEffort;
          break;
        case 'updateMode':
          this.currentMode = data.mode;
          this.postMessageToWebview({
            type: 'state',
            messages: this.currentMode === 'agent' ? this.getUiMessagesFromAgent() : this.getUiMessagesFromChat(),
            provider: this.currentProvider,
            model: this.currentModel,
            mode: this.currentMode,
            thinkingEffort: this.currentThinkingEffort,
            architectureExists: this.doesArchitectureFileExist()
          });
          break;
        case 'sendMessage':
          this.currentMode = data.options.mode;
          if (data.options.thinkingEffort) {
            this.currentThinkingEffort = data.options.thinkingEffort;
          }
          await this.handleUserMessage(data.text, data.attachments || [], data.options);
          break;
        case 'toolDecision':
          this.agent.handleDecision(data.toolId, data.approve);
          break;
        case 'viewDiff':
          this.openDiffViewer(data.path, data.originalPath);
          break;
        case 'stopGeneration':
          if (this.currentMode === 'agent') {
            this.agent.stop();
          } else {
            this.activeAbortController?.abort();
          }
          this.postMessageToWebview({ type: 'activeState', active: false });
          break;
        case 'resetChat':
          this.resetConversation();
          break;
      }
    });
  }

  resetConversation() {
    this.chatMessages = [];
    this.agent.reset();
    this.postMessageToWebview({
      type: 'state',
      messages: [],
      provider: this.currentProvider,
      model: this.currentModel,
      mode: this.currentMode,
      thinkingEffort: this.currentThinkingEffort,
      architectureExists: this.doesArchitectureFileExist()
    });
  }

  syncWorkspace() {
    const folders = vscode.workspace.workspaceFolders;
    const workspacePath = folders && folders.length > 0 ? folders[0].uri.fsPath : '';
    this.postMessageToWebview({
      type: 'workspace',
      path: workspacePath,
      architectureExists: this.doesArchitectureFileExist()
    });
  }

  private doesArchitectureFileExist(): boolean {
    const folders = vscode.workspace.workspaceFolders;
    const workspacePath = folders && folders.length > 0 ? folders[0].uri.fsPath : '';
    if (!workspacePath) return false;
    const reportsDir = path.join(workspacePath, '.cm_reports');
    return fs.existsSync(path.join(reportsDir, 'ARCHITECTURE.md')) ||
           fs.existsSync(path.join(reportsDir, 'architecture.md'));
  }

  private async sendInitialState() {
    const openrouterKey = getOpenRouterKeyFromEnv(this.context.extensionPath);

    const folders = vscode.workspace.workspaceFolders;
    const workspacePath = folders && folders.length > 0 ? folders[0].uri.fsPath : '';

    if (this.openRouterModels.length === 0) {
      const fetched = await fetchOpenRouterModels();
      if (fetched && fetched.length > 0) {
        this.openRouterModels = fetched;
      } else {
        this.openRouterModels = FALLBACK_MODELS;
      }
    }

    // Load from agent history if agent mode has active context, otherwise empty
    const uiMessages = this.currentMode === 'agent' 
      ? this.getUiMessagesFromAgent()
      : this.getUiMessagesFromChat();

    this.postMessageToWebview({
      type: 'state',
      messages: uiMessages,
      provider: 'OpenRouter',
      model: this.currentModel,
      mode: this.currentMode,
      thinkingEffort: this.currentThinkingEffort,
      workspacePath,
      keys: {
        openrouterKey: openrouterKey ? `sk-or-...${openrouterKey.slice(-6)}` : ''
      },
      models: this.openRouterModels,
      architectureExists: this.doesArchitectureFileExist()
    });
  }

  private async saveApiKeys() {
    vscode.window.showInformationMessage('Code Master: Configuration is loaded from the .env file in your workspace root.');
    await this.sendInitialState();
  }

  private async handleUserMessage(text: string, attachments: Attachment[], options: { provider: string; model: string; mode: 'chat' | 'agent'; thinkingEffort?: string }) {
    const apiKey = getOpenRouterKeyFromEnv(this.context.extensionPath);
    if (!apiKey) {
      this.postMessageToWebview({
        type: 'state',
        messages: [
          ...this.currentMode === 'agent' ? this.getUiMessagesFromAgent() : this.getUiMessagesFromChat(),
          {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content: `⚠️ OpenRouter API Key not found! Please create a \`.env\` file in your workspace root (\`${this.agent.getWorkspacePath()}\`) and add \`OPENROUTER_API_KEY=your_key_here\`.`
          }
        ]
      });
      return;
    }

    const imageAttachments = attachments.filter(a => a.type === 'image');
    const fileAttachments = attachments.filter(a => a.type === 'file');

    // Decode and parse files (handles text files as text, PDFs/Excels from base64 URLs)
    const fileTexts = await Promise.all(
      fileAttachments.map(async (file) => {
        try {
          const textVal = await getAttachmentTextContent(file);
          return { name: file.name, content: textVal };
        } catch (err: any) {
          return { name: file.name, content: `[Error parsing file contents: ${err.message || err}]` };
        }
      })
    );

    let apiContent: string | ChatMessageContentPart[];
    if (imageAttachments.length > 0) {
      const textPart: ChatMessageContentPart = {
        type: 'text',
        text: constructPromptWithFiles(text, fileTexts)
      };
      const imageParts: ChatMessageContentPart[] = imageAttachments.map(img => ({
        type: 'image_url',
        image_url: { url: img.content }
      }));
      apiContent = [textPart, ...imageParts];
    } else {
      apiContent = constructPromptWithFiles(text, fileTexts);
    }

    const requestThinkingEffort = options.thinkingEffort || this.currentThinkingEffort;

    if (options.mode === 'agent') {
      // Sync messages context with agent
      if (this.chatMessages.length > 0 && this.agent.getMessages().length === 0) {
        this.agent.setMessages([...this.chatMessages]);
      }
      
      await this.agent.run(
        apiContent,
        attachments,
        { provider: 'OpenRouter', model: options.model, apiKey, thinkingEffort: requestThinkingEffort },
        (state) => {
          this.postMessageToWebview({
            type: 'state',
            messages: state.messages,
            provider: 'OpenRouter',
            model: options.model,
            mode: 'agent',
            thinkingEffort: requestThinkingEffort,
            usage: state.usage
          });
          this.postMessageToWebview({
            type: 'activeState',
            active: state.isLlmActive
          });
        }
      );

      // Keep backend messages synced
      this.chatMessages = [...this.agent.getMessages()];
    } else {
      // Direct Chat Mode
      this.chatMessages.push({ role: 'user', content: apiContent, attachments });
      this.postMessageToWebview({
        type: 'state',
        messages: this.getUiMessagesFromChat(),
        provider: 'OpenRouter',
        model: options.model,
        mode: 'chat',
        thinkingEffort: requestThinkingEffort
      });
      this.postMessageToWebview({ type: 'activeState', active: true });

      let streamContent = '';
      let thoughtContent = '';
      let lastUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const streamId = `chat_stream_${Date.now()}`;

      let basePrompt = "You are a helpful coding assistant. Keep your responses concise and precise.";
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.scheme === 'file') {
        const doc = activeEditor.document;
        const relativePath = vscode.workspace.asRelativePath(doc.uri);
        const text = doc.getText();
        const cappedText = text.length > 50000 ? text.substring(0, 50000) + '\n... [truncated]' : text;
        basePrompt += `\n\nActive open file in editor:\nPath: ${relativePath}\n\`\`\`\n${cappedText}\n\`\`\``;
      }

      this.activeAbortController = new AbortController();

      try {
        await new Promise<void>((resolve, reject) => {
          streamChat(
            'OpenRouter',
            options.model,
            this.chatMessages,
            apiKey,
            basePrompt,
            {
              onToken: (token) => {
                streamContent += token;
                this.postMessageToWebview({
                  type: 'state',
                  messages: [
                    ...this.getUiMessagesFromChat(),
                    {
                      id: streamId,
                      role: 'assistant',
                      content: streamContent,
                      thought: thoughtContent,
                      isStreaming: true
                    }
                  ],
                  provider: 'OpenRouter',
                  model: options.model,
                  mode: 'chat',
                  thinkingEffort: requestThinkingEffort,
                  usage: lastUsage
                });
              },
              onThought: (thought) => {
                thoughtContent += thought;
                this.postMessageToWebview({
                  type: 'state',
                  messages: [
                    ...this.getUiMessagesFromChat(),
                    {
                      id: streamId,
                      role: 'assistant',
                      content: streamContent,
                      thought: thoughtContent,
                      isStreaming: true
                    }
                  ],
                  provider: 'OpenRouter',
                  model: options.model,
                  mode: 'chat',
                  thinkingEffort: requestThinkingEffort,
                  usage: lastUsage
                });
              },
              onUsage: (u) => {
                lastUsage = u;
                this.postMessageToWebview({
                  type: 'state',
                  messages: [
                    ...this.getUiMessagesFromChat(),
                    {
                      id: streamId,
                      role: 'assistant',
                      content: streamContent,
                      thought: thoughtContent,
                      isStreaming: true
                    }
                  ],
                  provider: 'OpenRouter',
                  model: options.model,
                  mode: 'chat',
                  thinkingEffort: requestThinkingEffort,
                  usage: u
                });
              },
              onError: (err) => reject(new Error(err)),
              onComplete: () => resolve()
            },
            this.activeAbortController?.signal,
            requestThinkingEffort
          );
        });

        this.chatMessages.push({ role: 'assistant', content: streamContent });
        this.postMessageToWebview({
          type: 'state',
          messages: this.getUiMessagesFromChat(),
          provider: 'OpenRouter',
          model: options.model,
          mode: 'chat',
          thinkingEffort: requestThinkingEffort
        });
      } catch (err: any) {
        this.chatMessages.push({
          role: 'assistant',
          content: `⚠️ Stream failed: ${err.message || err}`
        });
        this.postMessageToWebview({
          type: 'state',
          messages: this.getUiMessagesFromChat(),
          provider: 'OpenRouter',
          model: options.model,
          mode: 'chat',
          thinkingEffort: requestThinkingEffort
        });
      } finally {
        this.postMessageToWebview({ type: 'activeState', active: false });
      }
    }
  }

  private openDiffViewer(tempPath: string, originalPath: string) {
    const tempUri = vscode.Uri.file(tempPath);
    const originalUri = vscode.Uri.file(originalPath);
    const originalName = path.basename(originalPath);
    
    vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      tempUri,
      `Code Master: ${originalName} (Original ↔ Proposed)`
    );
  }

  private getUiMessagesFromChat(): any[] {
    return this.chatMessages.map((msg, idx) => ({
      id: `chat_${idx}`,
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : getMessageTextContent(msg.content),
      attachments: msg.attachments
    }));
  }

  private getUiMessagesFromAgent(): any[] {
    // If agent has messages, format them. Else maps chat history.
    const agentMsgs = this.agent.getMessages();
    if (agentMsgs.length === 0) return [];
    
    // We map agent messages using agent's custom renderer that strips XML tags and embeds tool structures
    return (this.agent as any).renderMessagesForUI();
  }

  private postMessageToWebview(msg: any) {
    if (this._view) {
      this._view.webview.postMessage(msg);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'assets', 'index.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'assets', 'index.css'));

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Assistant</title>
    <link rel="stylesheet" href="${cssUri}?v=${Date.now()}" />
  </head>
  <body class="bg-vscode-bg text-vscode-fg overflow-hidden h-screen w-screen selection:bg-vscode-activeBorder selection:text-white">
    <div id="root" class="h-full w-full"></div>
    <script type="module" src="${jsUri}?v=${Date.now()}"></script>
  </body>
</html>`;
  }
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  description?: string;
  pricing?: {
    prompt: string;
    completion: string;
    image: string;
    request: string;
  };
}

const FALLBACK_MODELS: OpenRouterModel[] = [
  { 
    id: 'google/gemini-2.5-flash', 
    name: 'Google: Gemini 2.5 Flash', 
    context_length: 1000000,
    pricing: { prompt: '0.000000075', completion: '0.0000003', image: '0', request: '0' }
  },
  { 
    id: 'google/gemini-2.5-pro', 
    name: 'Google: Gemini 2.5 Pro', 
    context_length: 128000,
    pricing: { prompt: '0.00000125', completion: '0.000005', image: '0', request: '0' }
  },
  { 
    id: 'deepseek/deepseek-chat', 
    name: 'DeepSeek Chat (V3)', 
    context_length: 64000,
    pricing: { prompt: '0.00000014', completion: '0.00000028', image: '0', request: '0' }
  },
  { 
    id: 'deepseek/deepseek-r1', 
    name: 'DeepSeek R1', 
    context_length: 163840,
    pricing: { prompt: '0.00000055', completion: '0.00000219', image: '0', request: '0' }
  },
  { 
    id: 'anthropic/claude-3.5-sonnet', 
    name: 'Anthropic: Claude 3.5 Sonnet', 
    context_length: 200000,
    pricing: { prompt: '0.000003', completion: '0.000015', image: '0', request: '0' }
  },
  { 
    id: 'openai/gpt-4o', 
    name: 'OpenAI: GPT-4o', 
    context_length: 128000,
    pricing: { prompt: '0.0000025', completion: '0.00001', image: '0', request: '0' }
  },
  { 
    id: 'meta-llama/llama-3.3-70b-instruct', 
    name: 'Meta: LLaMA 3.3 70B Instruct', 
    context_length: 131072,
    pricing: { prompt: '0.0000006', completion: '0.0000006', image: '0', request: '0' }
  }
];

function parseKeyFromEnv(envPath: string): string {
  if (!fs.existsSync(envPath)) {
    return '';
  }
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const parts = trimmed.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        if (key === 'OPENROUTER_API_KEY') {
          let val = parts.slice(1).join('=').trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.substring(1, val.length - 1);
          }
          return val;
        }
      }
    }
  } catch (e) {
    console.error('Error reading env file:', e);
  }
  return '';
}

function getOpenRouterKeyFromEnv(extensionPath?: string): string {
  // 1. Try active workspace folders first
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const workspaceRoot = folders[0].uri.fsPath;
    const envPath = path.join(workspaceRoot, '.env');
    const key = parseKeyFromEnv(envPath);
    if (key) {
      return key;
    }
  }

  // 2. Try extension path fallback
  if (extensionPath) {
    const envPath = path.join(extensionPath, '.env');
    const key = parseKeyFromEnv(envPath);
    if (key) {
      return key;
    }
  }

  // 3. Try bundler-level directory fallback
  try {
    const fallbackPath = path.join(__dirname, '..', '.env');
    const key = parseKeyFromEnv(fallbackPath);
    if (key) {
      return key;
    }
  } catch (e) {
    // Ignore
  }

  return '';
}

function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  return new Promise((resolve) => {
    const url = 'https://openrouter.ai/api/v1/models';
    const options = {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Code-Master-Extension'
      },
      timeout: 10000
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        resolve([]);
        return;
      }
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && Array.isArray(parsed.data)) {
            const models = parsed.data.map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              context_length: m.context_length || 0,
              description: m.description || '',
              pricing: m.pricing
            }));
            resolve(models);
          } else {
            resolve([]);
          }
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', () => {
      resolve([]);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

async function getAttachmentTextContent(attachment: Attachment): Promise<string> {
  if (attachment.content.startsWith('data:')) {
    const matches = attachment.content.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      return `[Unable to parse base64 for ${attachment.name}]`;
    }
    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    if (mimeType === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf')) {
      try {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(buffer);
        return pdfData.text || '';
      } catch (err: any) {
        return `[Error parsing PDF "${attachment.name}": ${err.message || err}]`;
      }
    }

    if (mimeType.includes('sheet') || mimeType.includes('excel') || attachment.name.toLowerCase().endsWith('.xlsx') || attachment.name.toLowerCase().endsWith('.xls')) {
      try {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        let text = '';
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          text += `Sheet: ${sheetName}\n${csv}\n\n`;
        }
        return text;
      } catch (err: any) {
        return `[Error parsing Excel "${attachment.name}": ${err.message || err}]`;
      }
    }

    // Default fallback: convert buffer to string
    return buffer.toString('utf8');
  }

  // If already text content
  return attachment.content;
}
