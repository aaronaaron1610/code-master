import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { streamChat, ChatMessage, ChatMessageContentPart, Attachment, getMessageTextContent, constructPromptWithFiles } from './llm';

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
  private toolSeq = 0;
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
    
    const relative = path.relative(this.workspaceRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
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
      // Inject attachments into the textual prompt so the LLM sees file contents.
      const rawText = typeof userContent === 'string' ? userContent : getMessageTextContent(userContent);
      const attachedText = attachments && attachments.length > 0
        ? constructPromptWithFiles(rawText, attachments.map(a => ({ name: a.name, content: a.content })))
        : rawText;

      this.messages.push({ role: 'user', content: attachedText, attachments });
    }

    const systemPrompt = this.getSystemPrompt();
    let loopActive = true;
    let lastToolSignature = '';
    let consecutiveToolCallCount = 0;

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
                      content: this.stripXmlTags(responseText),
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
                      content: this.stripXmlTags(responseText),
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
                      content: this.stripXmlTags(responseText),
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

        // Parse final tools and attach them directly to the assistant message in history
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

        // Execute all parsed tools in order
        for (let toolIndex = 0; toolIndex < tools.length; toolIndex++) {
          const tool = lastMsg.tools![toolIndex];
          // Ensure we're operating on the same object reference stored in messages
          this.pendingToolCall = tool;

          // Generic consecutive loop detection
          const toolSignature = `${tool.name}:${JSON.stringify(tool.arguments)}`;
        if (toolSignature === lastToolSignature) {
          consecutiveToolCallCount++;
          if (consecutiveToolCallCount >= 3) {
            loopActive = false;
            this.messages.push({
              role: 'assistant',
              content: `⚠️ Stopped execution: Detected an infinite loop pattern. The agent repeatedly called the same tool (${tool.name}) with identical arguments.`
            });
            onStateUpdate({
              messages: this.renderMessagesForUI(),
              isLlmActive: false,
              usage: this.cumulativeUsage
            });
            break;
          }
        } else {
          lastToolSignature = toolSignature;
          consecutiveToolCallCount = 1;
        }

          onStateUpdate({
            messages: this.renderMessagesForUI(),
            isLlmActive: false,
            usage: this.cumulativeUsage
          });

          // Execute tool (operate on reference stored in messages)
          let toolResult = await this.executeTool(tool, onStateUpdate);

          if (consecutiveToolCallCount === 2) {
            toolResult += `\n\n[SYSTEM NOTE: You have executed the tool "${tool.name}" consecutively with the exact same arguments. If you are repeating because of a perceived error, verify if the exit status or outputs show success. If the task is finished, summarize the results and stop calling tools.]`;
          }

          // Push tool response as a system message to context
          this.messages.push({
            role: 'system',
            content: `[Tool Result for ${tool.name}]:\n${toolResult}`
          });

          this.pendingToolCall = null;
        }

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
        const glob = tool.arguments.glob;
        const files = await this.toolListFiles(glob);
        tool.status = 'completed';
        tool.result = `Found ${files.length} files:\n` + files.join('\n');
        return tool.result;
      }
      
      if (tool.name === 'read_file') {
        const filePath = tool.arguments.path;
        const lineStart = tool.arguments.line_start ? parseInt(tool.arguments.line_start, 10) : undefined;
        const lineEnd = tool.arguments.line_end ? parseInt(tool.arguments.line_end, 10) : undefined;
        
        // Resolve lines to populate arguments correctly for the UI
        const absolutePath = this.resolvePath(filePath);
        let totalLines = 0;
        if (fs.existsSync(absolutePath)) {
          const fileContent = fs.readFileSync(absolutePath, 'utf8');
          totalLines = fileContent.split(/\r?\n/).length;
        }
        
        const resolvedStart = lineStart !== undefined ? Math.max(1, lineStart) : 1;
        const resolvedEnd = lineEnd !== undefined ? Math.min(totalLines, lineEnd) : (totalLines || 1);

        const content = await this.toolReadFile(filePath, resolvedStart, resolvedEnd);
        tool.status = 'completed';
        
        tool.arguments.line_start = resolvedStart.toString();
        tool.arguments.line_end = resolvedEnd.toString();
        
        tool.result = `Content of ${filePath} (Lines ${resolvedStart} to ${resolvedEnd}):\n${content}`;
        return tool.result;
      }
      
      if (tool.name === 'search_code') {
        const query = tool.arguments.query;
        const matches = await this.toolSearchCode(query);
        tool.status = 'completed';
        tool.result = matches.length > 0 
          ? `Found search matches:\n` + matches.map(m => `[FILE FOUND] ${m.file} — line ${m.line}: ${m.text}`).join('\n')
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

        // Create plan in markdown file and open it
        const reportsDir = path.join(this.workspaceRoot, '.cm_reports');
        if (!fs.existsSync(reportsDir)) {
          fs.mkdirSync(reportsDir, { recursive: true });
        }
        const planPath = path.join(reportsDir, 'coding_plan.md');
        try {
          const planContent = this.createPlanMarkdown(filePath, 'write', { content: fileContent });
          fs.writeFileSync(planPath, planContent, 'utf8');
          const planUri = vscode.Uri.file(planPath);
          try {
            await vscode.commands.executeCommand('markdown.showPreview', planUri);
          } catch {
            const doc = await vscode.workspace.openTextDocument(planUri);
            await vscode.window.showTextDocument(doc, { preview: true });
          }
        } catch (planErr) {
          console.error('Failed to create or display plan:', planErr);
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

          // Write changes summary
          this.writeChangesSummary(filePath, 'write', {
            content: fileContent,
            line_start: tool.arguments.line_start,
            line_end: tool.arguments.line_end
          });
        } else {
          tool.status = 'rejected';
          tool.result = `User REJECTED modifying/creating file: ${filePath}`;
        }

        // Clean up temp and plan files
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          if (!exists && fs.existsSync(originalDiffSource)) fs.unlinkSync(originalDiffSource);
          if (fs.existsSync(planPath)) fs.unlinkSync(planPath);
        } catch {
          // ignore cleanup errors
        }

        return tool.result;
      }

      if (tool.name === 'edit_file') {
        const filePath = tool.arguments.path;
        const searchContent = tool.arguments.search;
        const replaceContent = tool.arguments.replace;

        // Calculate line range of the edit
        const absolutePath = this.resolvePath(filePath);
        if (fs.existsSync(absolutePath)) {
          const content = fs.readFileSync(absolutePath, 'utf8');
          const normalize = (str: string) => str.replace(/\r\n/g, '\n');
          const normalizedContent = normalize(content);
          const normalizedSearch = normalize(searchContent);
          
          const index = normalizedContent.indexOf(normalizedSearch);
          if (index !== -1) {
            const textBefore = normalizedContent.substring(0, index);
            const startLine = textBefore.split('\n').length;
            const searchLinesCount = normalizedSearch.split('\n').length;
            const endLine = startLine + searchLinesCount - 1;
            
            tool.arguments.line_start = startLine.toString();
            tool.arguments.line_end = endLine.toString();
          }
        }

        const modifiedContent = await this.toolEditFile(filePath, searchContent, replaceContent);

        tool.status = 'pending';
        
        const tempDir = path.join(this.workspaceRoot, '.vscode', 'ai_coder_temp');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const fileBase = path.basename(filePath);
        const tempFilePath = path.join(tempDir, `proposed_${Date.now()}_${fileBase}`);
        fs.writeFileSync(tempFilePath, modifiedContent, 'utf8');
        tool.tempFilePath = tempFilePath;

        const absoluteDest = this.resolvePath(filePath);
        tool.arguments.originalPath = absoluteDest;

        // Create plan in markdown file and open it
        const reportsDir = path.join(this.workspaceRoot, '.cm_reports');
        if (!fs.existsSync(reportsDir)) {
          fs.mkdirSync(reportsDir, { recursive: true });
        }
        const planPath = path.join(reportsDir, 'coding_plan.md');
        try {
          const planContent = this.createPlanMarkdown(filePath, 'edit', { search: searchContent, replace: replaceContent });
          fs.writeFileSync(planPath, planContent, 'utf8');
          const planUri = vscode.Uri.file(planPath);
          try {
            await vscode.commands.executeCommand('markdown.showPreview', planUri);
          } catch {
            const doc = await vscode.workspace.openTextDocument(planUri);
            await vscode.window.showTextDocument(doc, { preview: true });
          }
        } catch (planErr) {
          console.error('Failed to create or display plan:', planErr);
        }

        onStateUpdate({ 
          messages: this.renderMessagesForUI(), 
          isLlmActive: false,
          usage: this.cumulativeUsage
        });

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
          
          fs.writeFileSync(absoluteDest, modifiedContent, 'utf8');
          
          tool.status = 'completed';
          tool.result = `Successfully edited file: ${filePath}`;

          // Write changes summary
          this.writeChangesSummary(filePath, 'edit', {
            search: searchContent,
            replace: replaceContent,
            line_start: tool.arguments.line_start,
            line_end: tool.arguments.line_end
          });
        } else {
          tool.status = 'rejected';
          tool.result = `User REJECTED modifying file: ${filePath}`;
        }

        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          if (fs.existsSync(planPath)) fs.unlinkSync(planPath);
        } catch {
          // ignore cleanup
        }

        return tool.result;
      }

      if (tool.name === 'run_command') {
        const command = tool.arguments.cmd;
        const safe = this.isCommandSafe(command);

        if (!safe) {
          tool.status = 'pending';
          onStateUpdate({ 
            messages: this.renderMessagesForUI(), 
            isLlmActive: false,
            usage: this.cumulativeUsage
          });

          const decision = await new Promise<{ approve: boolean }>((resolve) => {
            this.activeResolver = resolve;
          });

          this.activeResolver = null;

          if (!decision.approve) {
            tool.status = 'rejected';
            tool.result = `User REJECTED command execution: ${command}`;
            return tool.result;
          }
        }

        tool.status = 'running';
        onStateUpdate({ 
          messages: this.renderMessagesForUI(), 
          isLlmActive: false,
          usage: this.cumulativeUsage
        });

        const result = await this.toolRunCommand(command, this.abortController?.signal);
        tool.status = 'completed';
        tool.result = result;
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

  private async toolListFiles(globPattern?: string): Promise<string[]> {
    if (!this.workspaceRoot) return [];
    
    const pattern = globPattern || '**/*';
    // Find all files, ignoring node_modules, .git, and build artifacts
    const files = await vscode.workspace.findFiles(
      pattern,
      '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/ai_coder_temp/**}'
    );

    return files.map(file => vscode.workspace.asRelativePath(file));
  }

  private async toolReadFile(relativePath: string, lineStart?: number, lineEnd?: number): Promise<string> {
    const absolutePath = this.resolvePath(relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    const fullContent = fs.readFileSync(absolutePath, 'utf8');
    if (lineStart === undefined && lineEnd === undefined) {
      return fullContent;
    }

    const lines = fullContent.split(/\r?\n/);
    const totalLines = lines.length;

    const start = lineStart !== undefined ? Math.max(1, lineStart) : 1;
    const end = lineEnd !== undefined ? Math.min(totalLines, lineEnd) : totalLines;

    if (start > totalLines || start > end) {
      return `[Note: Requested line range ${start}-${end} is empty or out of bounds. Total lines in file: ${totalLines}]`;
    }

    const slicedLines = lines.slice(start - 1, end);
    return slicedLines.join('\n');
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

  private isCommandSafe(command: string): boolean {
    const cmd = command.trim().toLowerCase();
    // List of safe command prefixes
    const safePrefixes = [
      'npm install', 'pip install', 'cargo add',
      'ls', 'dir', 'find', 'grep', 'cat',
      'git status', 'git log', 'git diff', 'git show', 'git branch',
      'npm run test', 'npm test', 'pytest', 'cargo test',
      'npm run build', 'npm build', 'npm run compile', 'npm compile', 'make', 'tsc'
    ];
    for (const prefix of safePrefixes) {
      if (cmd.startsWith(prefix)) return true;
    }

    // Prefix-only unsafe checks: commands that start with destructive verbs
    const unsafePrefixes = [
      'rm ', 'del ', 'rmdir ', 'rd ', 'git reset', 'git clean', 'reset ', 'sudo ', 'drop ', 'delete '
    ];
    for (const up of unsafePrefixes) {
      if (cmd.startsWith(up)) return false;
    }

    // If not explicitly listed as safe, consider it unsafe by default.
    return false;
  }

  private async toolRunCommand(command: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      const child = cp.exec(command, { cwd: this.workspaceRoot }, (error, stdout, stderr) => {
        let result = '';
        if (stdout) result += stdout;
        if (stderr) result += `STDERR:\n${stderr}`;
        const exitCode = error ? (error as any).code : 0;
        result += `\nEXIT CODE: ${exitCode} ${exitCode === 0 ? '✓' : '✗'}`;
        if (exitCode === 0) {
          result += `\nNote: The command completed successfully (Exit Code 0). Any text under STDERR above is diagnostic output or warnings, not a failure.`;
        }
        resolve(result);
      });

      if (signal) {
        const onAbort = () => {
          try { child.kill(); } catch {}
          resolve('Execution aborted by user.');
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });
  }

  private async toolEditFile(filePath: string, searchContent: string, replaceContent: string): Promise<string> {
    const absolutePath = this.resolvePath(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    let content = fs.readFileSync(absolutePath, 'utf8');
    
    const normalize = (str: string) => str.replace(/\r\n/g, '\n');
    const normalizedContent = normalize(content);
    const normalizedSearch = normalize(searchContent);
    
    const index = normalizedContent.indexOf(normalizedSearch);
    if (index === -1) {
      const firstLine = searchContent.split('\n')[0] || '';
      throw new Error(`Could not find the SEARCH block in ${filePath}. Make sure the code in <<<<<<< SEARCH matches the file exactly (including spacing and indentation).\nSearching for: ${firstLine}`);
    }
    
    const lastIndex = normalizedContent.lastIndexOf(normalizedSearch);
    if (index !== lastIndex) {
      throw new Error(`The SEARCH block in ${filePath} is not unique. Please add more surrounding lines to uniquely identify the block.`);
    }
    
    const isCrlf = content.includes('\r\n');
    let finalReplace = replaceContent;
    if (isCrlf) {
      finalReplace = replaceContent.replace(/\n/g, '\r\n');
    }
    
    const searchRegexEscaped = searchContent.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n');
    const searchRegex = new RegExp(searchRegexEscaped);
    const match = content.match(searchRegex);
    if (!match) {
      content = content.replace(searchContent, finalReplace);
    } else {
      content = content.replace(match[0], finalReplace);
    }
    
    return content;
  }

  private createPlanMarkdown(filePath: string, action: 'write' | 'edit', details: { content?: string; search?: string; replace?: string }): string {
    const ext = path.extname(filePath).slice(1);
    const lang = ext || 'text';
    
    let md = `# Proposed Coding Plan\n\n`;
    md += `The AI Assistant is proposing to ${action === 'write' ? 'create/overwrite' : 'edit'} a file.\n\n`;
    md += `## Details\n`;
    md += `- **Action**: ${action === 'write' ? 'Write/Overwrite File' : 'Edit File'}\n`;
    md += `- **Target File**: \\\`${filePath}\\\`\n\n`;
    
    if (action === 'write') {
      md += `## Proposed Content\n`;
      md += `\`\`\`${lang}\n${details.content || ''}\n\`\`\`\n`;
    } else {
      md += `## Proposed Changes\n\n`;
      md += `### Search Block (to replace)\n`;
      md += `\`\`\`${lang}\n${details.search || ''}\n\`\`\`\n\n`;
      md += `### Replace Block (new code)\n`;
      md += `\`\`\`${lang}\n${details.replace || ''}\n\`\`\`\n`;
    }
    return md;
  }

  private writeChangesSummary(
    filePath: string,
    action: 'write' | 'edit',
    details: { content?: string; search?: string; replace?: string; line_start?: string; line_end?: string }
  ) {
    try {
      const reportsDir = path.join(this.workspaceRoot, '.cm_reports');
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }
      const changesPath = path.join(reportsDir, 'changes.md');
      
      const ext = path.extname(filePath).slice(1);
      const lang = ext || 'text';
      const timestamp = new Date().toLocaleString();
      
      let md = `# Summary of Applied Changes\n\n`;
      md += `**Timestamp**: ${timestamp}\n`;
      md += `**Action**: ${action === 'write' ? 'Write/Overwrite File' : 'Edit File'}\n`;
      md += `**File**: \`${filePath}\`\n`;
      if (details.line_start && details.line_end) {
        md += `**Lines**: ${details.line_start} to ${details.line_end}\n`;
      }
      md += `\n`;
      
      if (action === 'write') {
        md += `## Content Written\n`;
        const lines = (details.content || '').split('\n');
        if (lines.length > 100) {
          md += `\`\`\`${lang}\n${lines.slice(0, 100).join('\n')}\n... [truncated ${lines.length - 100} lines]\n\`\`\`\n`;
        } else {
          md += `\`\`\`${lang}\n${details.content || ''}\n\`\`\`\n`;
        }
      } else {
        md += `## Changes Applied\n\n`;
        md += `### Removed (Search Block):\n`;
        md += `\`\`\`${lang}\n${details.search || ''}\n\`\`\`\n\n`;
        md += `### Added (Replace Block):\n`;
        md += `\`\`\`${lang}\n${details.replace || ''}\n\`\`\`\n`;
      }
      
      fs.writeFileSync(changesPath, md, 'utf8');
      
      const changesUri = vscode.Uri.file(changesPath);
      vscode.commands.executeCommand('markdown.showPreview', changesUri).then(undefined, () => {
        vscode.workspace.openTextDocument(changesUri).then(doc => {
          vscode.window.showTextDocument(doc, { preview: true });
        });
      });
    } catch (err) {
      console.error('Failed to write changes summary:', err);
    }
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
          const matchedToolIndex = tools.findIndex(t => t.id === this.pendingToolCall!.id);
          if (matchedToolIndex !== -1) {
            tools[matchedToolIndex] = this.pendingToolCall;
          }
        }

        uiMessages.push({
          id: `msg_${idx}`,
          role: 'assistant',
          content: this.stripXmlTags(contentStr),
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
  private stripXmlTags(contentStr: string): string {
    return contentStr
      .replace(/<list_files(?:\s+glob=["']([^"']+)["'])?\s*\/>/g, '')
      .replace(/<read_file\s+([^>]+?)\s*\/>/g, '')
      .replace(/<search_code\s+query=["']([^"']+)["']\s*\/>/g, '')
      .replace(/<write_file\s+path=["']([^"']+)["']>([\s\S]*?)<\/write_file>/g, '')
      .replace(/<write_file\s+path=["']([^"']+)["']>([\s\S]*)/g, '')
      .replace(/<edit_file\s+path=["']([^"']+)["']>([\s\S]*?)<\/edit_file>/g, '')
      .replace(/<edit_file\s+path=["']([^"']+)["']>([\s\S]*)/g, '')
      .replace(/<run_command\s+cmd=["']([^"']+)["']\s*\/>/g, '')
      .trim();
  }

  private parseAttributes(attrString: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)=["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(attrString)) !== null) {
      attrs[match[1]] = match[2];
    }
    return attrs;
  }

  private parseActiveTools(content: string): ToolCall[] {
    const tools: ToolCall[] = [];
    let match: RegExpExecArray | null;

    // 1. list_files
    const listRegex = /<list_files(?:\s+glob=["']([^"']+)["'])?\s*\/>/g;
    while ((match = listRegex.exec(content)) !== null) {
      tools.push({
        id: this.generateToolId('list_files', 'list'),
        name: 'list_files',
        arguments: { glob: match[1] || undefined },
        status: 'pending'
      });
    }

    // 2. read_file (supporting optional line_start and line_end)
    const readRegex = /<read_file\s+([^>]+?)\s*\/>/g;
    while ((match = readRegex.exec(content)) !== null) {
      const attrs = this.parseAttributes(match[1]);
      if (attrs.path) {
        tools.push({
          id: this.generateToolId('read_file', attrs.path),
          name: 'read_file',
          arguments: {
            path: attrs.path,
            line_start: attrs.line_start || attrs.start_line || attrs.start || undefined,
            line_end: attrs.line_end || attrs.end_line || attrs.end || undefined
          },
          status: 'pending'
        });
      }
    }

    // 3. search_code
    const searchRegex = /<search_code\s+query=["']([^"']+)["']\s*\/>/g;
    while ((match = searchRegex.exec(content)) !== null) {
      tools.push({
        id: this.generateToolId('search_code', 'search'),
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
        id: this.generateToolId('write_file', filePath),
        name: 'write_file',
        arguments: { 
          path: filePath, 
          content: fileContent 
        },
        status: isComplete ? 'pending' : 'running'
      });
    }

    // 5. edit_file (complete or streaming)
    const editRegex = /<edit_file\s+path=["']([^"']+)["']>([\s\S]*?)(<\/edit_file>|$)/g;
    while ((match = editRegex.exec(content)) !== null) {
      const filePath = match[1];
      const isComplete = match[3] === '</edit_file>';
      const tagContent = match[2];
      
      let searchBlock = '';
      let replaceBlock = '';
      
      const searchStartIndex = tagContent.indexOf('<<<<<<< SEARCH');
      const searchEndIndex = tagContent.indexOf('=======');
      const replaceEndIndex = tagContent.indexOf('>>>>>>> REPLACE');
      
      if (searchStartIndex !== -1 && searchEndIndex !== -1 && replaceEndIndex !== -1) {
        searchBlock = tagContent.substring(searchStartIndex + '<<<<<<< SEARCH'.length, searchEndIndex).trim();
        replaceBlock = tagContent.substring(searchEndIndex + '======='.length, replaceEndIndex).trim();
      }

      tools.push({
        id: this.generateToolId('edit_file', filePath),
        name: 'edit_file',
        arguments: { 
          path: filePath, 
          search: searchBlock,
          replace: replaceBlock,
          raw: tagContent
        },
        status: isComplete ? 'pending' : 'running'
      });
    }

    // 6. run_command (complete or streaming)
    const runRegex = /<run_command\s+cmd=["']([^"']+)["']\s*\/>/g;
    while ((match = runRegex.exec(content)) !== null) {
      tools.push({
        id: this.generateToolId('run_command', 'run'),
        name: 'run_command',
        arguments: { cmd: match[1] },
        status: 'pending'
      });
    }

    return tools;
  }

  private generateToolId(kind: string, hint?: string) {
    this.toolSeq = (this.toolSeq || 0) + 1;
    const safeHint = (hint || '').toString().replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
    return `tool_${kind}_${safeHint}_${Date.now()}_${this.toolSeq}_${Math.random().toString(36).substring(2,6)}`;
  }

  private getSystemPrompt(): string {
    let prompt = `You are "AI Assistant", an autonomous coding assistant built inside VS Code.
You are tasked with helping the user edit, create, inspect and analyze code inside their active workspace folder.

You can perform actions using the following custom XML tags. Write the tags in your response. The extension will intercept them, run them, and feed the outputs back to you as a System Message.

Available Tools:
1. List workspace files (excludes node_modules and metadata) with optional glob pattern:
<list_files glob="src/**/*.ts"/> or <list_files/>

2. Read file content (optionally specify line range with line_start and line_end):
<read_file path="src/extension.ts" line_start="10" line_end="50"/> or <read_file path="src/extension.ts"/>

3. Search code for substrings/pattern:
<search_code query="pattern to find"/>

4. Write a new file or completely overwrite an existing file:
<write_file path="src/newFile.ts">
[file content here]
</write_file>

5. Edit a specific block of code in an existing file (targeted edits):
<edit_file path="src/extension.ts">
<<<<<<< SEARCH
[exact block of code to find]
=======
[block of code to replace it with]
>>>>>>> REPLACE
</edit_file>

6. Run a terminal command (e.g. testing, package installs, git):
<run_command cmd="npm run test"/>

RULES:
- You must explain your thinking to the user before issuing a tool call.
- Run ONLY ONE tool tag per turn. Once you write a tag, STOP your response immediately. Do not generate closing words or additional explanations after the tag.
- For write_file and edit_file, the user will inspect a diff comparison before approving.
- For run_command, safe commands (like testing, installs, logs) execute automatically. Destructive or custom commands require user approval.
- Be concise. Explain code clearly.`;

    let architectureDetails = '';
    if (this.workspaceRoot) {
      try {
        const archPathMd = path.join(this.workspaceRoot, 'ARCHITECTURE.md');
        const archPathLower = path.join(this.workspaceRoot, 'architecture.md');
        if (fs.existsSync(archPathMd)) {
          architectureDetails = fs.readFileSync(archPathMd, 'utf8');
        } else if (fs.existsSync(archPathLower)) {
          architectureDetails = fs.readFileSync(archPathLower, 'utf8');
        }
      } catch (e) {
        // Ignore read errors
      }
    }

    if (architectureDetails) {
      prompt += `\n\nImportant: You must align your code modifications and understanding with the project's architecture described below. Always review it first before starting your work:\n\`\`\`markdown\n${architectureDetails}\n\`\`\``;
    }

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
