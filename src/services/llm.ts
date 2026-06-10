import * as https from 'https';

export interface ChatMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface Attachment {
  name: string;
  type: 'image' | 'file';
  mimeType: string;
  content: string; // base64 data URL for images, plain text for files
  size?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ChatMessageContentPart[];
  thought?: string;
  tools?: any[];
  attachments?: Attachment[];
}

export function getMessageTextContent(content: string | ChatMessageContentPart[]): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textPart = content.find(p => p.type === 'text');
    return textPart ? textPart.text || '' : '';
  }
  return '';
}

export function constructPromptWithFiles(text: string, fileAttachments: { name: string; content: string }[]): string {
  if (fileAttachments.length === 0) {
    return text;
  }
  let formattedText = text;
  if (formattedText) {
    formattedText += "\n\n";
  }
  formattedText += "--- Attached Files ---";
  for (const file of fileAttachments) {
    // Skip base64 data URLs in textual injection. Image attachments are sent
    // as image_url parts; binary attachments (PDF/Excel) are parsed in the
    // extension host and replaced with their extracted text before this
    // function is called. Any remaining data: URL here is not useful to the
    // model and would be echoed back into the UI as a giant base64 blob.
    let injectedContent = file.content;
    if (typeof injectedContent === 'string' && injectedContent.startsWith('data:')) {
      const headerEnd = injectedContent.indexOf(',');
      const meta = headerEnd > 0 ? injectedContent.substring(0, headerEnd) : 'data:';
      injectedContent = `[Binary or data-URL content omitted from textual prompt (${meta}).]`;
    }
    formattedText += `\n\nFile: ${file.name}\n\`\`\`\n${injectedContent}\n\`\`\``;
  }
  formattedText += "\n--------------------";
  return formattedText;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onThought?: (thought: string) => void; // Support DeepSeek/Reasoning
  onError: (error: string) => void;
  onComplete: (fullText: string) => void;
  onUsage?: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void;
}

export function modelSupportsReasoning(modelId: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.includes('r1') ||
         id.includes('o1') ||
         id.includes('o3') ||
         id.includes('thinking') ||
         id.includes('reasoning');
}

export async function streamChat(
  _provider: string,
  model: string,
  messages: ChatMessage[],
  apiKey: string,
  systemPrompt: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  thinkingEffort?: string
): Promise<void> {
  try {
    if (!apiKey) {
      throw new Error(`OpenRouter API key is missing. Please configure OPENROUTER_API_KEY in your .env file in the workspace root.`);
    }
    await streamOpenRouter(model, messages, apiKey, systemPrompt, callbacks, signal, thinkingEffort);
  } catch (err: any) {
    callbacks.onError(err.message || String(err));
  }
}

/**
 * Helper to make a streaming HTTPS POST request.
 * We use the native Node.js 'https' module because it is universally available
 * in the VS Code environment and handles streaming chunks reliably.
 */
function makeHttpsStreamRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  onChunk: (data: string) => void,
  onEnd: () => void,
  onError: (err: Error) => void,
  signal?: AbortSignal
) {
  const parsedUrl = new URL(url);
  const options: https.RequestOptions = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    headers: headers,
    rejectUnauthorized: true,
    signal: signal
  };

  const req = https.request(options, (res) => {
    if (res.statusCode && res.statusCode >= 400) {
      let errBody = '';
      res.on('data', (d) => { errBody += d; });
      res.on('end', () => {
        let msg = `API request failed with status code ${res.statusCode}`;
        try {
          const parsed = JSON.parse(errBody);
          msg += `: ${parsed.error?.message || parsed.error || errBody}`;
        } catch {
          msg += `: ${errBody}`;
        }
        onError(new Error(msg));
      });
      return;
    }

    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      onChunk(chunk);
    });
    res.on('end', () => {
      onEnd();
    });
  });

  req.on('error', (err) => {
    onError(err);
  });

  // Fallback abort handling for Node versions that don't wire AbortSignal into https.request
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', () => {
      try {
        req.destroy(new Error('Request aborted'));
      } catch {
        try { req.abort(); } catch {}
      }
    }, { once: true });
  }

  req.write(body);
  req.end();
}

/**
 * SSE Buffer Parser
 * Splits raw stream data by newlines and processes valid "data: " rows.
 */
class SseParser {
  private buffer = '';
  private onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  feed(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Save incomplete last line to buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.onLine(trimmed);
    }
  }

  flush() {
    if (this.buffer.trim()) {
      this.onLine(this.buffer.trim());
      this.buffer = '';
    }
  }
}

function stripXmlTags(contentStr: string): string {
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

export function cleanMessagesForLlm(messages: ChatMessage[]): ChatMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) {
    return messages;
  }

  const cleaned: ChatMessage[] = [];

  interface Turn {
    userMessage: ChatMessage;
    otherMessages: ChatMessage[];
  }
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (let i = 0; i < lastUserIdx; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = { userMessage: msg, otherMessages: [] };
    } else {
      if (currentTurn) {
        currentTurn.otherMessages.push(msg);
      } else {
        cleaned.push(msg);
      }
    }
  }
  if (currentTurn) {
    turns.push(currentTurn);
  }

  for (const turn of turns) {
    cleaned.push({
      role: 'user',
      content: typeof turn.userMessage.content === 'string'
        ? turn.userMessage.content
        : getMessageTextContent(turn.userMessage.content)
    });

    for (const msg of turn.otherMessages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : getMessageTextContent(msg.content);
        if (!text.startsWith('[Tool Result')) {
          cleaned.push(msg);
        }
      }
    }

    let lastAssistant: ChatMessage | null = null;
    for (let j = turn.otherMessages.length - 1; j >= 0; j--) {
      if (turn.otherMessages[j].role === 'assistant') {
        lastAssistant = turn.otherMessages[j];
        break;
      }
    }

    if (lastAssistant) {
      const rawContent = typeof lastAssistant.content === 'string'
        ? lastAssistant.content
        : getMessageTextContent(lastAssistant.content);
      const cleanedContent = stripXmlTags(rawContent).trim();
      cleaned.push({
        role: 'assistant',
        content: cleanedContent
      });
    }
  }

  for (let i = lastUserIdx; i < messages.length; i++) {
    cleaned.push(messages[i]);
  }

  return cleaned;
}

async function streamOpenRouter(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
  systemPrompt: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  thinkingEffort?: string
) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const apiMessages = [];
  if (systemPrompt) {
    apiMessages.push({ role: 'system', content: systemPrompt });
  }
  const cleanedHistory = cleanMessagesForLlm(messages);
  for (const msg of cleanedHistory) {
    const contentStr = typeof msg.content === 'string' ? msg.content : getMessageTextContent(msg.content);
    apiMessages.push({ role: msg.role, content: contentStr });
  }

  const bodyData: any = {
    model,
    messages: apiMessages,
    stream: true,
    stream_options: {
      include_usage: true
    }
  };

  if (modelSupportsReasoning(model) && thinkingEffort) {
    bodyData.reasoning = {
      effort: thinkingEffort.toLowerCase()
    };
  }

  const body = JSON.stringify(bodyData);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://github.com/antigravity/code-master',
    'X-Title': 'Code Master VS Code Extension'
  };

  let fullText = '';
  let fullThought = '';
  const parser = new SseParser((line) => {
    if (line === 'data: [DONE]') return;
    if (line.startsWith('data: ')) {
      try {
        const jsonStr = line.substring(6);
        const data = JSON.parse(jsonStr);
        
        // Handle thoughts/reasoning delta (common in deepseek-r1 on OpenRouter)
        const thought = data.choices?.[0]?.delta?.reasoning || data.choices?.[0]?.delta?.thought || '';
        if (thought && callbacks.onThought) {
          fullThought += thought;
          callbacks.onThought(thought);
        }

        const text = data.choices?.[0]?.delta?.content || '';
        if (text) {
          fullText += text;
          callbacks.onToken(text);
        }
        if (data.usage && callbacks.onUsage) {
          callbacks.onUsage({
            input: data.usage.prompt_tokens || 0,
            output: data.usage.completion_tokens || 0,
            cacheRead: data.usage.prompt_tokens_details?.cached_tokens || 0,
            cacheWrite: 0
          });
        }
      } catch (e) {
        // Skip metadata chunks
      }
    }
  });

  makeHttpsStreamRequest(
    url,
    headers,
    body,
    (chunk) => parser.feed(chunk),
    () => {
      parser.flush();
      callbacks.onComplete(fullText);
    },
    (err) => callbacks.onError(err.message),
    signal
  );
}

export async function summarizeMessages(
  messages: ChatMessage[],
  apiKey: string,
  model: string
): Promise<string> {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  
  const conversationText = messages.map(msg => {
    const roleName = msg.role === 'user' ? 'User' : (msg.role === 'assistant' ? 'Assistant' : 'System/Tool');
    const text = typeof msg.content === 'string' ? msg.content : getMessageTextContent(msg.content);
    return `${roleName}: ${text}`;
  }).join('\n\n');

  const prompt = `You are an assistant. Please write a highly concise bullet-point summary of the following conversation history. Focus only on the key objectives, files discussed, and decisions made. Keep it under 150 words and use clear bullet points.
    
Conversation:
${conversationText}

Summary:`;

  const body = JSON.stringify({
    model: model,
    messages: [{ role: 'user', content: prompt }]
  });

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://github.com/antigravity/code-master',
    'X-Title': 'Code Master VS Code Extension'
  };

  return new Promise<string>((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      method: 'POST',
      headers
    };

    const req = https.request(options, (res) => {
      let bodyData = '';
      res.on('data', chunk => bodyData += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(bodyData);
          const summary = json.choices?.[0]?.message?.content || '';
          resolve(summary.trim());
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
