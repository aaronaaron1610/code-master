import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { streamChat, ChatMessage, ChatMessageContentPart, Attachment, getMessageTextContent } from './llm';

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'completed' | 'error';
  result?: string;
  tempFilePath?: string;
}

export class Agent {
  private messages: ChatMessage[] = [];
  private workspaceRoot: string = '';
  private activeResolver: ((decision: { approve: boolean }) => void) | null = null;
  private pendingToolCall: ToolCall | null = null;
  private abortController: AbortController | null = null;
  private cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  constructor() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      this.workspaceRoot = folders[0].uri.fsPath;
    }
  }

  getWorkspacePath(): string {
    return this.workspaceRoot;
  }

  reset() {
    this.messages = [];
    this.pendingToolCall = null;
    this.activeResolver = null;
    this.abortController = null;
    this.cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  setMessages(msgs: ChatMessage[]) {
    this.messages = msgs;
  }

  /**
   * Resolves a relative workspace path to an absolute path.
   * Throws an error if the path points outside the workspace.
   */
  private resolvePath(relativePath: string): string {
    if (!this.workspaceRoot) {
      throw new Error("No open workspace folder found.");
    }
    const cleanRelative = relativePath.trim().replace(/^[\/\\]/, '');
    const absolute = path.resolve(this.workspaceRoot, cleanRelative);
    if (!absolute.startsWith(this.workspaceRoot)) {
      throw new Error(`Path security violation: ${relativePath} lies outside workspace.`);
    }
    return absolute;
  }

  /**
   * Main Agent Execution Loop
   */
  async run(
    userContent: string | ChatMessageContentPart[],
    attachments: Attachment[] | undefined,
    options: { provider: string; model: string; apiKey: string; thinkingEffort?: string },
    onStateUpdate: (state: { messages: any[]; isLlmActive: boolean; usage?: any }) => void
  ) {
    this.abortController = new AbortController();
    this.cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    if (userContent) {
      this.messages.push({ role: 'user', content: userContent, attachments });
    }

    const systemPrompt = this.getSystemPrompt();
    let loopActive = true;

    while (loopActive) {
      if (this.abortController.signal.aborted) {
        loopActive = false;
        break;
      }

      onStateUpdate({
        messages: this.renderMessagesForUI(),
        isLlmActive: true,
        usage: this.cumulativeUsage
      });

      let responseText = '';
      let thoughtText = '';
      let streamingMessageId = Math.random().toString();
      let lastUsageForIteration = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      
      try {
        await new Promise<void>((resolve, reject) => {
          streamChat(
            options.provider,
            options.model,
            this.messages,
            options.apiKey,
            systemPrompt,
            {
              onToken: (token) => {
                responseText += token;
                // Update UI state with current streaming content
                onStateUpdate({
                  messages: [
                    ...this.renderMessagesForUI(),
                    {
                      id: streamingMessageId,
                      role: 'assistant',
                      content: responseText,
                      thought: thoughtText,
                      isStreaming: true,
                      tools: this.parseActiveTools(responseText)
                    }
                  ],
                  isLlmActive: true,
                  usage: {
                    input: this.cumulativeUsage.input + lastUsageForIteration.input,
                    output: this.cumulativeUsage.output + lastUsageForIteration.output,
                    cacheRead: this.cumulativeUsage.cacheRead + lastUsageForIteration.cacheRead,
                    cacheWrite: this.cumulativeUsage.cacheWrite + lastUsageForIteration.cacheWrite
                  }
                });
              },
              onThought: (thought) => {
                thoughtText += thought;
                onStateUpdate({
                  messages: [
                    ...this.renderMessagesForUI(),
                    {
                      id: streamingMessageId,
                      role: 'assistant',
                      content: responseText,
                      thought: thoughtText,
                      isStreaming: true,
                      tools: this.parseActiveTools(responseText)
                    }
                  ],
                  isLlmActive: true,
                  usage: {
                    input: this.cumulativeUsage.input + lastUsageForIteration.input,
                    output: this.cumulativeUsage.output + lastUsageForIteration.output,
                    cacheRead: this.cumulativeUsage.cacheRead + lastUsageForIteration.cacheRead,
                    cacheWrite: this.cumulativeUsage.cacheWrite + lastUsageForIteration.cacheWrite
                  }
                });
              },
              onUsage: (u) => {
                lastUsageForIteration = u;
                onStateUpdate({
                  messages: [
                    ...this.renderMessagesForUI(),
                    {
                      id: streamingMessageId,
                      role: 'assistant',
                      content: responseText,
                      thought: thoughtText,
                      isStreaming: true,
                      tools: this.parseActiveTools(responseText)
                    }
                  ],
                  isLlmActive: true,
                  usage: {
                    input: this.cumulativeUsage.input + u.input,
                    output: this.cumulativeUsage.output + u.output,
                    cacheRead: this.cumulativeUsage.cacheRead + u.cacheRead,
                    cacheWrite: this.cumulativeUsage.cacheWrite + u.cacheWrite
                  }
                });
              },
              onError: (err) => reject(new Error(err)),
              onComplete: (fullText) => {
                responseText = fullText;
                resolve();
              }
            },
            this.abortController?.signal,
            options.thinkingEffort
          );
        });

        this.cumulativeUsage.input += lastUsageForIteration.input;
        this.cumulativeUsage.output += lastUsageForIteration.output;
        this.cumulativeUsage.cacheRead += lastUsageForIteration.cacheRead;
        this.cumulativeUsage.cacheWrite += lastUsageForIteration.cacheWrite;

        // Parse final tools
        const finalTools = this.parseActiveTools(responseText);

        // Push completed message to history with tools populated
        this.messages.push({ 
          role: 'assistant', 
          content: responseText,
          thought: thoughtText || undefined,
          tools: finalTools.length > 0 ? finalTools : undefined
        });

        const lastMsg = this.messages[this.messages.length - 1];
        const tools = lastMsg.tools || [];

        if (tools.length === 0) {
          // No more tools called, agent has finished answering
          loopActive = false;
          onStateUpdate({
            messages: this.renderMessagesForUI(),
            isLlmActive: false,
            usage: this.cumulativeUsage
          });
          break;
        }

        // Execute parsed tool
        const tool = tools[0];
        this.pendingToolCall = tool;

        onStateUpdate({
          messages: this.renderMessagesForUI(),
          isLlmActive: false,
          usage: this.cumulativeUsage
        });

        // Execute tool
        const toolResult = await this.executeTool(tool, onStateUpdate);
        
        // Push tool response as a system message to context
        this.messages.push({
          role: 'system',
          content: `[Tool Result for ${tool.name}]:\n${toolResult}`
        });

        this.pendingToolCall = null;

      } catch (err: any) {
        loopActive = false;
        this.messages.push({
          role: 'assistant',
          content: `⚠️ Error occurred during agent loop:\n${err.message || err}`
        });
        onStateUpdate({
          messages: this.renderMessagesForUI(),
          isLlmActive: false,
          usage: this.cumulativeUsage
        });
      }
    }
  }

  /**
   * Evaluates and runs a parsed tool action, handling manual approvals.
   */
  private async executeTool(
    tool: ToolCall,
    onStateUpdate: (state: any) => void
  ): Promise<string> {
    tool.status = 'running';
    onStateUpdate({ 
      messages: this.renderMessagesForUI(), 
      isLlmActive: false,
      usage: this.cumulativeUsage
    });

    try {
      if (tool.name === 'list_files') {
        const files = await this.toolListFiles();
        tool.status = 'completed';
        tool.result = `Found ${files.length} files:\n` + files.join('\n');
        return tool.result;
      }
      
      if (tool.name === 'read_file') {
        const filePath = tool.arguments.path;
        const content = await this.toolReadFile(filePath);
        tool.status = 'completed';
        tool.result = `Content of ${filePath}:\n${content}`;
        return tool.result;
      }
      
      if (tool.name === 'search_code') {
        const query = tool.arguments.query;
        const matches = await this.toolSearchCode(query);
        tool.status = 'completed';
        tool.result = matches.length > 0 
          ? `Found search matches:\n` + matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n')
          : `No matches found for query: "${query}"`;
        return tool.result;
      }
      
      if (tool.name === 'write_file') {
        const filePath = tool.arguments.path;
        const fileContent = tool.arguments.content;

        // Create the diff and await decision
        tool.status = 'pending';
        
        // Write the content to a temp file for VS Code diff view
        const tempDir = path.join(this.workspaceRoot, '.vscode', 'ai_coder_temp');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const fileBase = path.basename(filePath);
        const tempFilePath = path.join(tempDir, `proposed_${Date.now()}_${fileBase}`);
        fs.writeFileSync(tempFilePath, fileContent, 'utf8');
        tool.tempFilePath = tempFilePath;

        // Set original path for VS Code diff reference
        const absoluteDest = this.resolvePath(filePath);
        const exists = fs.existsSync(absoluteDest);
        
        // If dest doesn't exist, create an empty file so vscode.diff has a source
        let originalDiffSource = absoluteDest;
        if (!exists) {
          const emptyTempPath = path.join(tempDir, `empty_${Date.now()}_${fileBase}`);
          fs.writeFileSync(emptyTempPath, '', 'utf8');
          originalDiffSource = emptyTempPath;
          tool.arguments.originalPath = emptyTempPath;
        } else {
          tool.arguments.originalPath = absoluteDest;
        }

        onStateUpdate({ 
          messages: this.renderMessagesForUI(), 
          isLlmActive: false,
          usage: this.cumulativeUsage
        });

        // Wait for decision
        const decision = await new Promise<{ approve: boolean }>((resolve) => {
          this.activeResolver = resolve;
        });

        this.activeResolver = null;

        if (decision.approve) {
          tool.status = 'running';
          onStateUpdate({ 
            messages: this.renderMessagesForUI(), 
            isLlmActive: false,
            usage: this.cumulativeUsage
          });
          
          // Apply changes to real file
          const dir = path.dirname(absoluteDest);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(absoluteDest, fileContent, 'utf8');
          
          tool.status = 'completed';
          tool.result = `Successfully wrote content to file: ${filePath}`;
        } else {
          tool.status = 'rejected';
          tool.result = `User REJECTED modifying/creating file: ${filePath}`;
        }

        // Clean up temp files
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          if (!exists && fs.existsSync(originalDiffSource)) fs.unlinkSync(originalDiffSource);
        } catch {
          // ignore cleanup errors
        }

        return tool.result;
      }

      throw new Error(`Unknown tool: ${tool.name}`);

    } catch (err: any) {
      tool.status = 'error';
      tool.result = `Error executing tool: ${err.message || err}`;
      return tool.result;
    }
  }

  /**
   * Responds to user manual decisions on tools.
   */
  handleDecision(toolId: string, approve: boolean) {
    if (this.pendingToolCall && this.pendingToolCall.id === toolId && this.activeResolver) {
      this.activeResolver({ approve });
    }
  }

  // ----------------------------------------------------
  // TOOL IMPLEMENTATIONS
  // ----------------------------------------------------

  private async toolListFiles(): Promise<string[]> {
    if (!this.workspaceRoot) return [];
    
    // Find all files, ignoring node_modules, .git, and build artifacts
    const files = await vscode.workspace.findFiles(
      '**/*',
      '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/ai_coder_temp/**}'
    );

    return files.map(file => vscode.workspace.asRelativePath(file));
  }

  private async toolReadFile(relativePath: string): Promise<string> {
    const absolutePath = this.resolvePath(relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return fs.readFileSync(absolutePath, 'utf8');
  }

  private async toolSearchCode(query: string): Promise<{ file: string; line: number; text: string }[]> {
    if (!this.workspaceRoot) return [];
    
    const files = await this.toolListFiles();
    const results: { file: string; line: number; text: string }[] = [];
    const queryLower = query.toLowerCase();

    // programmatically search through project files
    for (const relPath of files) {
      try {
        const fullPath = path.join(this.workspaceRoot, relPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        
        if (content.toLowerCase().includes(queryLower)) {
          const lines = content.split('\n');
          lines.forEach((lineText, idx) => {
            if (lineText.toLowerCase().includes(queryLower)) {
              if (results.length < 100) { // Safety cap
                results.push({
                  file: relPath,
                  line: idx + 1,
                  text: lineText.trim()
                });
              }
            }
          });
        }
      } catch {
        // Skip files that fail to read (binary, etc.)
      }
      if (results.length >= 100) break;
    }

    return results;
  }

  // ----------------------------------------------------
  // PARSER & PROMPT HELPERS
  // ----------------------------------------------------

  /**
   * Helper that returns a custom styled list of messages.
   * Maps current messages and embeds active tool structures in the last assistant response.
   */
  private renderMessagesForUI(): any[] {
    const uiMessages: any[] = [];
    
    this.messages.forEach((msg, idx) => {
      const isLast = idx === this.messages.length - 1;
      
      if (msg.role === 'assistant') {
        const contentStr = typeof msg.content === 'string' ? msg.content : getMessageTextContent(msg.content);
        const tools = msg.tools ? [...msg.tools] : this.parseActiveTools(contentStr);
        
        // If this is the last message and we have a pending/running tool in memory, preserve its status
        if (isLast && this.pendingToolCall) {
          const matchedToolIndex = tools.findIndex(t => t.id === this.pendingToolCall!.id || t.name === this.pendingToolCall!.name);
          if (matchedToolIndex !== -1) {
            tools[matchedToolIndex] = this.pendingToolCall;
          }
        }

        // Clean out the XML tags from user message content in UI display
        let displayContent = contentStr
          .replace(/<list_files\s*\/>/g, '')
          .replace(/<read_file\s+path=["']([^"']+)["']\s*\/>/g, '')
          .replace(/<search_code\s+query=["']([^"']+)["']\s*\/>/g, '')
          .replace(/<write_file\s+path=["']([^"']+)["']>([\s\S]*?)<\/write_file>/g, '')
          // Also handle opening/incomplete tags while streaming
          .replace(/<write_file\s+path=["']([^"']+)["']>([\s\S]*)/g, '')
          .trim();

        uiMessages.push({
          id: `msg_${idx}`,
          role: 'assistant',
          content: displayContent,
          tools: tools.length > 0 ? tools : undefined
        });
      } else {
        uiMessages.push({
          id: `msg_${idx}`,
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : getMessageTextContent(msg.content),
          attachments: msg.attachments
        });
      }
    });

    return uiMessages;
  }

  /**
   * Incremental XML tag scanner that extracts tool commands.
   */
  private parseActiveTools(content: string): ToolCall[] {
    const tools: ToolCall[] = [];

    // 1. list_files
    if (content.includes('<list_files/>') || content.includes('<list_files />')) {
      tools.push({
        id: 'tool_list',
        name: 'list_files',
        arguments: {},
        status: 'pending'
      });
    }

    // 2. read_file
    const readRegex = /<read_file\s+path=["']([^"']+)["']\s*\/>/g;
    let match;
    while ((match = readRegex.exec(content)) !== null) {
      tools.push({
        id: `tool_read_${match[1].replace(/[^a-zA-Z0-9]/g, '_')}`,
        name: 'read_file',
        arguments: { path: match[1] },
        status: 'pending'
      });
    }

    // 3. search_code
    const searchRegex = /<search_code\s+query=["']([^"']+)["']\s*\/>/g;
    while ((match = searchRegex.exec(content)) !== null) {
      tools.push({
        id: `tool_search_${Math.random().toString(36).substring(2, 7)}`,
        name: 'search_code',
        arguments: { query: match[1] },
        status: 'pending'
      });
    }

    // 4. write_file (complete or streaming)
    const writeRegex = /<write_file\s+path=["']([^"']+)["']>([\s\S]*?)(<\/write_file>|$)/g;
    while ((match = writeRegex.exec(content)) !== null) {
      const filePath = match[1];
      const isComplete = match[3] === '</write_file>';
      const fileContent = match[2];

      tools.push({
        id: `tool_write_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`,
        name: 'write_file',
        arguments: { 
          path: filePath, 
          content: fileContent 
        },
        // If it's not complete, it's still streaming in the model response
        status: isComplete ? 'pending' : 'running'
      });
    }

    return tools;
  }

  private getSystemPrompt(): string {
    let prompt = `You are "AI Assistant", an autonomous coding assistant built inside VS Code.
You are tasked with helping the user edit, create, inspect and analyze code inside their active workspace folder.

You can perform actions using the following custom XML tags. Write the tags in your response. The extension will intercept them, run them, and feed the outputs back to you as a System Message.

Available Tools:
1. List all workspace files (excludes node_modules and metadata):
<list_files/>

2. Read file content:
<read_file path="src/extension.ts"/>

3. Search code for substrings/pattern:
<search_code query="pattern to find"/>

4. Write a new file or completely overwrite an existing file:
<write_file path="src/newFile.ts">
[file content here]
</write_file>

RULES:
- You must explain your thinking to the user before issuing a tool call.
- Run ONLY ONE tool tag per turn. Once you write a tag, STOP your response immediately. Do not generate closing words or additional explanations after the tag.
- For write_file, the user will inspect a diff comparison before approving.
- Be concise. Explain code clearly.`;

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      const doc = activeEditor.document;
      const relativePath = vscode.workspace.asRelativePath(doc.uri);
      const text = doc.getText();
      const cappedText = text.length > 50000 ? text.substring(0, 50000) + '\n... [truncated]' : text;
      prompt += `\n\nActive open file in editor:\nPath: ${relativePath}\n\`\`\`\n${cappedText}\n\`\`\``;
    }

    return prompt;
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
