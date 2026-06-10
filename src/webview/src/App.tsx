import React, { useState, useEffect, useRef } from 'react';
import {
  Send, Sparkles, RefreshCw, ChevronDown, Check, X,
  Terminal, FileText, Search, FileCode, CheckCircle, AlertTriangle,
  Paperclip, Bot, MessageSquare, Compass, ArrowDown, ArrowUp, Database, Gauge
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import logo from './assets/logo.png';

// Safely acquire VS Code API inside the webview environment
const vscode = (() => {
  if (typeof acquireVsCodeApi !== 'undefined') {
    return acquireVsCodeApi();
  }
  return {
    postMessage: (message: any) => {
      console.log('PostMessage (mock):', message);
    },
    getState: () => ({}),
    setState: (state: any) => { }
  };
})();

function modelSupportsReasoning(modelId: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.includes('r1') ||
    id.includes('o1') ||
    id.includes('o3') ||
    id.includes('thinking') ||
    id.includes('reasoning');
}

function getPriceCategory(model: any): string {
  if (!model?.pricing) return 'Low cost';
  const promptPrice = parseFloat(model.pricing.prompt || '0');
  const credits = promptPrice * 1e9;
  if (credits <= 150) return 'Low cost';
  if (credits <= 1000) return 'Medium cost';
  return 'High cost';
}

function getCachedInputPrice(model: any): number {
  if (!model?.pricing) return 0;
  const promptPrice = parseFloat(model.pricing.prompt || '0');
  const id = (model.id || '').toLowerCase();
  if (id.includes('anthropic/')) {
    return promptPrice * 0.1;
  }
  if (id.includes('deepseek/')) {
    return promptPrice * 0.25;
  }
  if (id.includes('google/')) {
    return promptPrice * 0.25;
  }
  if (id.includes('openai/')) {
    return promptPrice * 0.5;
  }
  return promptPrice * 0.1;
}

function formatCredits(pricePerToken: string | number | undefined): string {
  if (pricePerToken === undefined) return '0';
  const val = typeof pricePerToken === 'string' ? parseFloat(pricePerToken) : pricePerToken;
  if (isNaN(val)) return '0';
  const credits = val * 1e9;
  if (credits === 0) return '0';
  if (credits < 1) return credits.toFixed(2);
  if (credits < 10) return credits.toFixed(1);
  return Math.round(credits).toString();
}

interface Attachment {
  id?: string;
  name: string;
  type: 'image' | 'file';
  mimeType: string;
  content: string;
  size?: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreaming?: boolean;
  thought?: string;
  tools?: ToolCall[];
  attachments?: Attachment[];
}

interface ToolCall {
  id: string;
  name: string;
  arguments: any;
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'completed' | 'error';
  result?: string;
}

interface SavedKeys {
  openrouterKey?: string;
}

function parseInline(text: string): React.ReactNode[] {
  if (!text) return [];
  const parts: React.ReactNode[] = [];
  let currentIndex = 0;
  const tokenRegex = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    const matchIndex = match.index;
    if (matchIndex > currentIndex) {
      parts.push(text.substring(currentIndex, matchIndex));
    }
    if (match[1]) {
      parts.push(<strong key={matchIndex} className="font-semibold text-white">{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={matchIndex} className="italic text-vscode-fg/90">{match[4]}</em>);
    } else if (match[5]) {
      parts.push(
        <code key={matchIndex} className="bg-vscode-inputBg/80 px-1.5 py-0.5 rounded text-rose-300 font-mono text-[12px] border border-vscode-inputBorder/50">
          {match[5]}
        </code>
      );
    } else if (match[6] && match[7]) {
      parts.push(
        <a
          key={matchIndex}
          href={match[7]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-vscode-activeBorder hover:underline font-semibold"
        >
          {match[6]}
        </a>
      );
    }
    currentIndex = tokenRegex.lastIndex;
  }

  if (currentIndex < text.length) {
    parts.push(text.substring(currentIndex));
  }

  return parts;
}

const CodeBlock = ({ language, code }: { language: string; code: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text', err);
    }
  };

  return (
    <div className="my-3.5 border border-vscode-inputBorder rounded-lg overflow-hidden bg-vscode-editorBg/60 backdrop-blur-sm shadow-md">
      <div className="flex justify-between items-center px-4 py-2 bg-vscode-inputBg/80 text-[11px] text-vscode-fg/60 border-b border-vscode-inputBorder/55 font-mono select-none">
        <span className="font-semibold text-vscode-activeBorder/95">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center space-x-1 hover:text-white transition-colors py-0.5 px-2 rounded hover:bg-vscode-bg/50 cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-400 font-semibold">Copied!</span>
            </>
          ) : (
            <>
              <FileText className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="m-0 p-4 text-[12px] overflow-x-auto font-mono text-emerald-300 leading-relaxed bg-black/30 whitespace-pre-wrap">
        <code>{code}</code>
      </pre>
    </div>
  );
};

const ThinkingProcess = ({
  thought,
  defaultOpen = false
}: {
  thought: string;
  defaultOpen?: boolean;
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="mb-3.5 border border-amber-500/20 bg-amber-500/5 rounded-lg overflow-hidden transition-all duration-200">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 bg-amber-500/10 text-[12px] hover:bg-amber-500/15 transition-colors cursor-pointer select-none font-mono text-amber-400 font-semibold"
      >
        <div className="flex items-center space-x-2">
          <Sparkles className="h-3.5 w-3.5 text-amber-400 animate-pulse" />
          <span>Thinking Process</span>
        </div>
        <div className="flex items-center space-x-1">
          <span className="text-[10px] text-amber-400/50 mr-1">
            {isOpen ? 'Collapse' : 'Expand'}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {isOpen && (
        <div className="p-3 border-t border-amber-500/10 text-vscode-fg/80 whitespace-pre-wrap leading-relaxed text-[11px] font-mono italic bg-amber-950/20 max-h-[220px] overflow-y-auto">
          {thought}
        </div>
      )}
    </div>
  );
};

const CollapsibleCodeResult = ({ content }: { content: string }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-1.5 select-text">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        className="flex items-center space-x-1 text-[10px] text-cyan-400 hover:text-cyan-300 font-bold bg-vscode-inputBg/40 border border-vscode-inputBorder/35 px-2.5 py-1 rounded transition-all cursor-pointer select-none"
      >
        <span>{expanded ? 'Hide Code Content' : 'Show Code Content'}</span>
      </button>
      {expanded && (
        <pre className="m-0 p-2.5 bg-black/40 border border-vscode-inputBorder/35 rounded font-mono text-[11px] text-vscode-fg/85 leading-normal max-h-[220px] overflow-y-auto whitespace-pre-wrap animate-fade-in">
          <code>{content}</code>
        </pre>
      )}
    </div>
  );
};

const ToolStep = ({
  tool,
  onToolDecision,
  onViewDiff
}: {
  tool: ToolCall;
  onToolDecision: (toolId: string, approve: boolean) => void;
  onViewDiff: (path: string, originalPath: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(tool.status === 'pending' || tool.status === 'running');
  let title = tool.name;
  let Icon = Terminal;
  let iconColorClass = "text-purple-400";
  let targetDesc = "";

  if (tool.name === 'list_files') {
    title = tool.arguments.glob ? `Scanning files matching "${tool.arguments.glob}"` : 'Scanning workspace files';
  } else if (tool.name === 'read_file') {
    const filename = tool.arguments.path ? tool.arguments.path.split(/[/\\]/).pop() : '';
    const start = tool.arguments.line_start;
    const end = tool.arguments.line_end;
    const lineRange = start && end ? ` (Lines ${start} to ${end})` : '';
    title = `Reading file: ${filename || tool.arguments.path}${lineRange}`;
    Icon = FileText;
    iconColorClass = "text-blue-400";
    targetDesc = tool.arguments.path;
  } else if (tool.name === 'search_code') {
    title = `Searching codebase for "${tool.arguments.query}"`;
    Icon = Search;
    iconColorClass = "text-amber-400";
    targetDesc = tool.arguments.query;
  } else if (tool.name === 'write_file') {
    const filename = tool.arguments.path ? tool.arguments.path.split(/[/\\]/).pop() : '';
    title = `Writing file: ${filename || tool.arguments.path}`;
    Icon = FileCode;
    iconColorClass = "text-emerald-400";
    targetDesc = tool.arguments.path;
  } else if (tool.name === 'edit_file') {
    const filename = tool.arguments.path ? tool.arguments.path.split(/[/\\]/).pop() : '';
    const start = tool.arguments.line_start;
    const end = tool.arguments.line_end;
    const lineRange = start && end ? ` (Lines ${start} to ${end})` : '';
    title = `Editing file: ${filename || tool.arguments.path}${lineRange}`;
    Icon = FileCode;
    iconColorClass = "text-emerald-400";
    targetDesc = tool.arguments.path;
  } else if (tool.name === 'run_command') {
    title = `Executing command: ${tool.arguments.cmd}`;
    Icon = Terminal;
    iconColorClass = "text-purple-400";
    targetDesc = tool.arguments.cmd;
  }

  let statusBadge = '';
  let statusBadgeColor = 'bg-vscode-inputBg text-vscode-fg/60 border-vscode-inputBorder';
  let StatusIcon = null;

  if (tool.status === 'completed') {
    statusBadge = 'Completed';
    statusBadgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    StatusIcon = <CheckCircle className="h-3.5 w-3.5 text-emerald-400 shrink-0" />;
  } else if (tool.status === 'running') {
    statusBadge = 'Running';
    statusBadgeColor = 'bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse';
    StatusIcon = <RefreshCw className="h-3.5 w-3.5 text-blue-400 shrink-0 animate-spin" />;
  } else if (tool.status === 'pending') {
    statusBadge = 'Pending Approval';
    statusBadgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    StatusIcon = <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 animate-pulse" />;
  } else if (tool.status === 'rejected') {
    statusBadge = 'Rejected';
    statusBadgeColor = 'bg-red-500/10 text-red-400 border-red-500/20';
    StatusIcon = <X className="h-3.5 w-3.5 text-red-400 shrink-0" />;
  } else if (tool.status === 'error') {
    statusBadge = 'Error';
    statusBadgeColor = 'bg-red-500/10 text-red-400 border-red-500/20 border';
    StatusIcon = <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />;
  }

  const isWrite = tool.name === 'write_file' || tool.name === 'edit_file';
  const isCommand = tool.name === 'run_command';

  return (
    <div className="border border-vscode-inputBorder/70 bg-vscode-inputBg/35 rounded-lg overflow-hidden transition-all duration-200 shadow-sm hover:border-vscode-inputBorder">
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between p-2.5 bg-vscode-inputBg/45 hover:bg-vscode-inputBg/60 transition-colors cursor-pointer select-none font-sans text-xs"
      >
        <div className="flex items-center space-x-2.5 min-w-0">
          <div className={`p-1.5 bg-vscode-bg rounded border border-vscode-inputBorder/50 shrink-0 ${iconColorClass}`}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <span className="font-semibold text-white/95 truncate" title={title}>{title}</span>
        </div>
        <div className="flex items-center space-x-2 shrink-0">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono border uppercase font-bold tracking-wider ${statusBadgeColor} flex items-center space-x-1`}>
            {StatusIcon}
            <span>{statusBadge || tool.status}</span>
          </span>
          <ChevronDown className={`h-3.5 w-3.5 text-vscode-fg/40 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </div>
      {isOpen && (
        <div className="p-3 border-t border-vscode-inputBorder/45 space-y-2.5 text-xs bg-black/10">
          {targetDesc && (
            <div className="flex items-start justify-between bg-black/25 px-2.5 py-1.5 rounded border border-vscode-inputBorder/40 font-mono text-[11px]">
              <span className="text-vscode-fg/50 mr-1 shrink-0">
                {tool.name === 'search_code' ? 'Query:' : (tool.name === 'run_command' ? 'Command:' : 'Target:')}
              </span>
              <span className="text-white/90 break-all text-right">{targetDesc}</span>
            </div>
          )}
          {isWrite && tool.status === 'pending' && (
            <div className="flex flex-col space-y-2.5 border border-amber-500/20 bg-amber-500/5 p-3 rounded-lg animate-fade-in">
              <div className="flex items-start space-x-2 text-amber-400 text-[11px] leading-relaxed">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 animate-bounce" />
                <span>An agent requests to edit or write a file. Please review the changes carefully before approving.</span>
              </div>
              <div className="flex space-x-2 pt-1">
                <button
                  onClick={(e) => { e.stopPropagation(); onViewDiff(tool.arguments.path, tool.arguments.originalPath); }}
                  className="flex-1 bg-vscode-bg border border-vscode-inputBorder hover:border-vscode-activeBorder hover:bg-vscode-inputBg/50 text-white py-1.5 rounded font-medium text-[11px] transition-all cursor-pointer flex items-center justify-center space-x-1 shadow-sm"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Preview Diff</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onToolDecision(tool.id, true); }}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded font-medium text-[11px] transition-all cursor-pointer flex items-center justify-center space-x-1 shadow"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>Approve</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onToolDecision(tool.id, false); }}
                  className="bg-red-700 hover:bg-red-600 text-white px-2.5 py-1.5 rounded font-medium text-[11px] transition-all cursor-pointer flex items-center justify-center space-x-1 shadow"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Reject</span>
                </button>
              </div>
            </div>
          )}
          {isCommand && tool.status === 'pending' && (
            <div className="flex flex-col space-y-2.5 border border-amber-500/20 bg-amber-500/5 p-3 rounded-lg animate-fade-in">
              <div className="flex items-start space-x-2 text-amber-400 text-[11px] leading-relaxed">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 animate-bounce" />
                <span>An agent requests to execute a terminal command. Please review the command carefully before approving.</span>
              </div>
              <div className="flex space-x-2 pt-1">
                <button
                  onClick={(e) => { e.stopPropagation(); onToolDecision(tool.id, true); }}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-1.5 rounded font-medium text-[11px] transition-all cursor-pointer flex items-center justify-center space-x-1 shadow"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>Approve</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onToolDecision(tool.id, false); }}
                  className="flex-1 bg-red-700 hover:bg-red-600 text-white py-1.5 rounded font-medium text-[11px] transition-all cursor-pointer flex items-center justify-center space-x-1 shadow"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Reject</span>
                </button>
              </div>
            </div>
          )}
          {tool.result && (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase font-mono tracking-wider font-semibold text-vscode-fg/40">Execution Result:</div>
              {tool.name === 'read_file' ? (
                <CollapsibleCodeResult content={tool.result} />
              ) : (
                <pre className="m-0 p-2.5 bg-black/40 border border-vscode-inputBorder/35 rounded font-mono text-[11px] text-vscode-fg/85 leading-normal max-h-[140px] overflow-y-auto whitespace-pre-wrap">
                  <code>{tool.result}</code>
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'chat' | 'agent'>('agent');
  const [provider, setProvider] = useState<string>('OpenRouter');
  const [model, setModel] = useState('google/gemini-2.5-flash');
  const [keys, setKeys] = useState<SavedKeys>({});
  const [isLlmActive, setIsLlmActive] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [usage, setUsage] = useState<{ input: number; output: number; cacheRead: number; cacheWrite: number } | null>(null);
  const [architectureExists, setArchitectureExists] = useState(false);

  const [thinkingEffort, setThinkingEffort] = useState<'none' | 'low' | 'medium' | 'high' | 'xhigh'>('medium');
  const [isThinkingDropdownOpen, setIsThinkingDropdownOpen] = useState(false);
  const [hoveredModel, setHoveredModel] = useState<any | null>(null);

  const [isModeDropdownOpen, setIsModeDropdownOpen] = useState(false);
  const modeDropdownRef = useRef<HTMLDivElement>(null);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [inputHeight, setInputHeight] = useState(34);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = (files: FileList) => {
    Array.from(files).forEach((file) => {
      const isImage = file.type.startsWith('image/');
      const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
      const isExcel = file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls') || file.type.includes('spreadsheet') || file.type.includes('excel');

      const isBinary = isImage || isPdf || isExcel;
      const maxSize = isBinary ? 10 * 1024 * 1024 : 2 * 1024 * 1024;
      if (file.size > maxSize) {
        alert(`File "${file.name}" is too large. Max allowed size is ${maxSize / (1024 * 1024)}MB.`);
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (typeof result === 'string') {
          setAttachments((prev) => {
            if (prev.some((a) => a.name === file.name)) return prev;
            return [
              ...prev,
              {
                id: Math.random().toString(36).substring(2, 9),
                name: file.name,
                type: isImage ? 'image' : 'file',
                mimeType: file.type || (isPdf ? 'application/pdf' : isExcel ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain'),
                content: result,
                size: file.size,
              },
            ];
          });
        }
      };

      if (isBinary) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault();
      processFiles(e.clipboardData.files);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const [modelsList, setModelsList] = useState<any[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setIsDropdownOpen(false);
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(event.target as Node)) setIsThinkingDropdownOpen(false);
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(event.target as Node)) setIsModeDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });

    const handleEvent = (event: MessageEvent) => {
      const data = event.data;
      switch (data.type) {
        case 'state':
          if (data.messages) setMessages(data.messages);
          if (data.provider) setProvider(data.provider);
          if (data.model) setModel(data.model);
          if (data.keys) setKeys(data.keys);
          if (data.mode) setMode(data.mode);
          if (data.workspacePath) setWorkspacePath(data.workspacePath);
          if (data.models) setModelsList(data.models);
          if (data.thinkingEffort) setThinkingEffort(data.thinkingEffort);
          if (data.architectureExists !== undefined) setArchitectureExists(data.architectureExists);
          setUsage(data.usage || null);
          break;
        case 'activeState':
          setIsLlmActive(data.active);
          break;
        case 'workspace':
          setWorkspacePath(data.path);
          if (data.architectureExists !== undefined) setArchitectureExists(data.architectureExists);
          break;
        case 'architectureState':
          setArchitectureExists(data.exists);
          break;
      }
    };

    window.addEventListener('message', handleEvent);
    return () => window.removeEventListener('message', handleEvent);
  }, []);

  useEffect(() => {
    const container = document.querySelector('main.flex-1.overflow-y-auto');
    if (!container) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const el = container as HTMLElement;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);

    // Only auto-scroll if user is already at/near the bottom.
    // If they scrolled up to read something, we won't yank them down.
    const isNearBottom = distanceFromBottom < 120; // px threshold

    if (isNearBottom) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLlmActive]);

  // Handle dynamic auto-growing and auto-shrinking height of textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      // Calculate dynamic height bound between 22px and 140px
      const newHeight = input.trim() === '' ? 22 : Math.min(scrollHeight - 4, 160);
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [input]);

  const handleStartCodeDiscovery = () => {
    if (isLlmActive) return;
    updateMode('agent');

    const promptText = "Analyze this workspace's files, structure, and technologies, and create a comprehensive ARCHITECTURE.md file in the workspace root that details the project's architecture.";

    // Always use GPT 5.4 for code discovery, regardless of the currently selected model
    const discoveryModel = 'openai/gpt-5.4';

    vscode.postMessage({
      type: 'sendMessage',
      text: promptText,
      attachments: [],
      options: {
        mode: 'agent',
        provider: 'OpenRouter',
        model: discoveryModel,
        thinkingEffort: modelSupportsReasoning(discoveryModel) ? thinkingEffort : undefined
      }
    });
  };

  const handleSendMessage = () => {
    if ((!input.trim() && attachments.length === 0) || isLlmActive) return;

    vscode.postMessage({
      type: 'sendMessage',
      text: input,
      attachments: attachments.map(a => ({
        name: a.name,
        type: a.type,
        mimeType: a.mimeType,
        content: a.content,
        size: a.size
      })),
      options: {
        mode,
        provider: 'OpenRouter',
        model,
        thinkingEffort: modelSupportsReasoning(model) ? thinkingEffort : undefined
      }
    });
    setInput('');
    setAttachments([]);
  };

  const handleStopMessage = () => {
    vscode.postMessage({ type: 'stopGeneration' });
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const resetChat = () => {
    vscode.postMessage({ type: 'resetChat' });
    setUsage(null);
  };

  const updateModel = (selectedModel: string) => {
    setModel(selectedModel);
    vscode.postMessage({ type: 'updateModel', model: selectedModel, provider: 'OpenRouter' });
  };

  const updateMode = (selectedMode: 'chat' | 'agent') => {
    setMode(selectedMode);
    vscode.postMessage({ type: 'updateMode', mode: selectedMode });
  };

  const handleToolDecision = (toolId: string, approve: boolean) => {
    vscode.postMessage({
      type: 'toolDecision',
      toolId,
      approve
    });
  };

  const openDiffView = (path: string, originalPath: string) => {
    vscode.postMessage({
      type: 'viewDiff',
      path,
      originalPath
    });
  };

  const renderMarkdownContent = (content: string) => {
    if (!content) return null;

    return (
      <div className="space-y-2 break-words text-[12px] leading-relaxed text-vscode-fg/90">
        <ReactMarkdown
          components={{
            pre({ children }) {
              return <>{children}</>;
            },
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const isBlock = match || String(children).includes('\n');
              if (isBlock) {
                return (
                  <CodeBlock
                    language={match ? match[1] : ''}
                    code={String(children).replace(/\n$/, '')}
                  />
                );
              }
              return (
                <code className="bg-vscode-inputBg/80 px-1.5 py-0.5 rounded text-rose-300 font-mono text-[12px] border border-vscode-inputBorder/50" {...props}>
                  {children}
                </code>
              );
            },
            p({ children }) {
              return <p className="mb-2 last:mb-0">{children}</p>;
            },
            a({ href, children }) {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-vscode-activeBorder hover:underline font-semibold"
                >
                  {children}
                </a>
              );
            },
            ul({ children }) {
              return <ul className="list-disc pl-4 space-y-1 my-1.5">{children}</ul>;
            },
            ol({ children }) {
              return <ol className="list-decimal pl-4 space-y-1 my-1.5">{children}</ol>;
            },
            li({ children }) {
              return <li className="leading-relaxed">{children}</li>;
            },
            h1({ children }) {
              return <h1 className="text-[13px] font-extrabold text-white mt-3 mb-1 first:mt-0">{children}</h1>;
            },
            h2({ children }) {
              return <h2 className="text-xs font-bold text-white mt-3 mb-1 first:mt-0">{children}</h2>;
            },
            h3({ children }) {
              return <h3 className="text-[11px] font-semibold text-white mt-2 mb-1 first:mt-0">{children}</h3>;
            },
            blockquote({ children }) {
              return <blockquote className="border-l-2 border-vscode-activeBorder/60 bg-vscode-inputBg/10 pl-3 py-1 my-2 italic text-vscode-fg/80">{children}</blockquote>;
            }
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  };

  const defaultModelOrder = [
    'openai/gpt-5.4-mini',
    'openai/gpt-5.4',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.6',
    'google/gemini-3.5-flash',
  ];

  const normalizedModelId = (value: string) =>
    value.toLowerCase().replace(/\s+/g, '').replace(/[._]/g, '-');

  const defaultModelLabels: Record<string, string> = {
    'openai/gpt-5.4-mini': 'GPT 5.4 Mini',
    'openai/gpt-5.4': 'GPT 5.4',
    'anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',
    'anthropic/claude-opus-4.6': 'Claude Opus 4.6',
    'google/gemini-3.5-flash': 'Gemini 3.5 Flash',
  };

  const preferredModels = modelsList.filter((m) => {
    const id = normalizedModelId(m.id || '');
    const name = normalizedModelId(m.name || '');
    return defaultModelOrder.some((defaultId) => {
      const normalizedDefaultId = normalizedModelId(defaultId);
      return id.includes(normalizedDefaultId) || name.includes(normalizedDefaultId);
    });
  });

  const preferredModelIds = new Set(preferredModels.map((m) => m.id));

  const otherModels = modelsList.filter(
    (m) =>
      !preferredModelIds.has(m.id) &&
      (m.name || m.id).toLowerCase().includes(modelSearch.toLowerCase())
  );

  const filteredModels = [
    ...preferredModels,
    ...otherModels,
  ];

  return (
    <div className="flex flex-col h-screen text-vscode-fg bg-vscode-bg antialiased select-text overflow-hidden">
      {/* Scrollable chat/home area */}
      <main className="flex-1 overflow-y-auto p-3.5 space-y-4">
        {messages.length === 0 ? (
          // Extremely minimal Home UI screen
          <div className="flex flex-col items-center justify-center min-h-[85%] text-center px-4 py-8 space-y-4 select-none animate-slide-up">
            <div className="relative flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-tr from-cyan-500 to-indigo-600 shadow-md shadow-indigo-500/20">
              <Sparkles className="w-6 h-6 text-white animate-pulse" />
            </div>

            <div className="space-y-1">
              <h1 className="text-[14px] font-extrabold tracking-tight text-white">
                Code Master
              </h1>
              <p className="text-[11px] text-vscode-fg/50 max-w-[210px] mx-auto leading-relaxed">
                Ask anything about the workspace, or let the Agent run tasks.
              </p>
            </div>

            <div className="pt-2">
              {architectureExists ? (
                <button
                  type="button"
                  onClick={handleStartCodeDiscovery}
                  disabled={isLlmActive}
                  className="inline-flex items-center space-x-2 px-4 py-2 rounded-lg bg-vscode-inputBg border border-vscode-inputBorder/55 text-[11px] text-white hover:bg-vscode-inputBg/80 transition-all cursor-pointer font-bold shadow-md hover:border-vscode-activeBorder hover:scale-[1.02] active:scale-95 duration-200"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 shrink-0 ${isLlmActive ? 'animate-spin' : ''}`} />
                  <span>Refresh Discovery</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartCodeDiscovery}
                  disabled={isLlmActive}
                  className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-[11px] text-white transition-all cursor-pointer font-bold shadow-md shadow-indigo-500/35 hover:scale-[1.02] active:scale-95 duration-200"
                >
                  <Compass className="w-3.5 h-3.5 text-white shrink-0 animate-pulse" />
                  <span>Code Discovery</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          // Message log bubbles
          <div className="space-y-4">
            {messages.map((msg) => {
              const isUser = msg.role === 'user';
              return (
                <div key={msg.id} className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
                  {isUser ? (
                    // User Message Block
                    <div className="flex flex-col items-end max-w-[85%] space-y-1">
                      <div className="bg-vscode-inputBg border border-vscode-inputBorder/60 text-white rounded-xl rounded-tr-sm px-3 py-2 shadow-sm text-xs leading-relaxed break-words w-full">
                        {renderMarkdownContent(msg.content)}
                      </div>

                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1 justify-end">
                          {msg.attachments.map((att) => {
                            const isImg = att.type === 'image';
                            return (
                              <div
                                key={att.id || att.name}
                                className="flex items-center space-x-1.5 p-1 bg-vscode-inputBg/40 border border-vscode-inputBorder/30 rounded text-[9px] text-vscode-fg/50 max-w-[130px]"
                              >
                                {isImg ? (
                                  <img src={att.content} className="w-3.5 h-3.5 object-cover rounded" alt={att.name} />
                                ) : (
                                  <FileText className="w-3.5 h-3.5 text-vscode-fg/40 shrink-0" />
                                )}
                                <span className="truncate">{att.name}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    // Assistant Message Block
                    <div className="flex items-start space-x-2.5 max-w-[90%]">
                      <div className="relative flex items-center justify-center w-5.5 h-5.5 rounded bg-gradient-to-tr from-cyan-500 to-indigo-600 shadow-sm text-white shrink-0 mt-0.5">
                        <Sparkles className="w-3 h-3" />
                      </div>
                      <div className="flex-1 bg-vscode-inputBg/15 border border-vscode-inputBorder/35 rounded-xl rounded-tl-sm px-3 py-2 space-y-2.5 shadow-sm overflow-hidden">

                        {/* Collapsible reasoning history */}
                        {msg.thought && <ThinkingProcess thought={msg.thought} />}

                        {/* Styled message description */}
                        <div className="text-xs space-y-2">
                          {renderMarkdownContent(msg.content)}
                        </div>

                        {/* Spinner during response creation */}
                        {msg.isStreaming && !msg.content && !msg.thought && (
                          <div className="flex items-center space-x-1.5 text-vscode-fg/50 text-[10px] font-mono italic">
                            <RefreshCw className="h-2.5 w-2.5 animate-spin text-vscode-activeBorder" />
                            <span>Thinking...</span>
                          </div>
                        )}

                        {/* Custom agent tool step list */}
                        {msg.tools && msg.tools.length > 0 && (
                          <div className="space-y-2 pt-1.5">
                            {msg.tools.map((tool) => (
                              <ToolStep
                                key={tool.id}
                                tool={tool}
                                onToolDecision={handleToolDecision}
                                onViewDiff={openDiffView}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={chatEndRef} />
          </div>
        )}
      </main>

      {/* Sticky footer input area - containing input AND all selectors always visible at the bottom */}
      <footer className="border-t border-vscode-inputBorder/45 bg-vscode-bg/95 backdrop-blur-md p-2.5 shrink-0 z-10 space-y-2 shadow-lg">
        {/* Row 1: Selectors & Controls (Mode Toggle, Model, Reasoning, Reset) */}
        <div className="flex items-center justify-between pb-0.5 select-none">
          {/* Mode Dropdown (Agent vs Chat) */}
          <div className="relative" ref={modeDropdownRef}>
            <button
              type="button"
              onClick={() => setIsModeDropdownOpen(!isModeDropdownOpen)}
              className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-vscode-inputBg/85 border border-vscode-inputBorder/40 text-[9px] text-vscode-fg/75 hover:bg-vscode-inputBg transition-all cursor-pointer font-semibold"
              title="Select Mode"
            >
              {mode === 'agent' ? (
                <Bot className="w-2.5 h-2.5 text-cyan-400 shrink-0" />
              ) : (
                <MessageSquare className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
              )}
              <span className="capitalize">{mode}</span>
              <ChevronDown className="w-2.5 h-2.5 text-vscode-fg/40 shrink-0" />
            </button>

            {isModeDropdownOpen && (
              <div className="absolute bottom-full left-0 mb-1.5 w-[110px] bg-vscode-inputBg border border-vscode-inputBorder/80 rounded-lg shadow-xl z-50 text-[10px] overflow-hidden animate-fade-in py-0.5">
                <button
                  type="button"
                  onClick={() => {
                    updateMode('agent');
                    setIsModeDropdownOpen(false);
                  }}
                  className={`w-full text-left px-2 py-1 hover:bg-vscode-bg transition-colors flex items-center justify-between cursor-pointer font-bold ${
                    mode === 'agent' ? 'text-cyan-400' : 'text-vscode-fg/80'
                  }`}
                >
                  <div className="flex items-center space-x-1.5">
                    <Bot className="w-3 h-3 text-cyan-400" />
                    <span>Agent</span>
                  </div>
                  {mode === 'agent' && <Check className="w-2.5 h-2.5 text-cyan-400 shrink-0" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updateMode('chat');
                    setIsModeDropdownOpen(false);
                  }}
                  className={`w-full text-left px-2 py-1 hover:bg-vscode-bg transition-colors flex items-center justify-between cursor-pointer font-bold ${
                    mode === 'chat' ? 'text-indigo-400' : 'text-vscode-fg/80'
                  }`}
                >
                  <div className="flex items-center space-x-1.5">
                    <MessageSquare className="w-3 h-3 text-indigo-400" />
                    <span>Chat</span>
                  </div>
                  {mode === 'chat' && <Check className="w-2.5 h-2.5 text-indigo-400 shrink-0" />}
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-1.5">
            {/* Model Selection Dropdown (Opens Upward) */}
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-vscode-inputBg/85 border border-vscode-inputBorder/40 text-[9px] text-vscode-fg/75 hover:bg-vscode-inputBg transition-all cursor-pointer max-w-[110px] font-semibold"
                title="Select Active Model"
              >
                <span className="truncate">{modelsList.find((m) => m.id === model)?.name || 'Select Model'}</span>
                <ChevronDown className="w-2.5 h-2.5 text-vscode-fg/40 shrink-0" />
              </button>

              {isDropdownOpen && (
                <div className="absolute bottom-full right-0 mb-1.5 w-[220px] bg-vscode-inputBg border border-vscode-inputBorder/80 rounded-lg shadow-xl z-50 text-[11px] overflow-hidden animate-fade-in">
                  <div className="p-1.5 border-b border-vscode-inputBorder/40 flex items-center space-x-1.5">
                    <Search className="w-3 h-3 text-vscode-fg/40 shrink-0" />
                    <input
                      type="text"
                      placeholder="Search models..."
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      className="w-full bg-transparent outline-none text-[10px] text-vscode-inputFg placeholder:text-vscode-fg/30"
                    />
                  </div>
                  <div className="max-h-[180px] overflow-y-auto divide-y divide-vscode-inputBorder/20">
                    {filteredModels.length > 0 ? (
                      filteredModels.map((m) => {
                        const isSelected = m.id === model;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              updateModel(m.id);
                              setIsDropdownOpen(false);
                            }}
                            className={`w-full text-left px-2.5 py-1 hover:bg-vscode-bg transition-colors flex items-start justify-between text-[10.5px] cursor-pointer ${isSelected ? 'bg-vscode-bg text-vscode-activeBorder font-bold' : 'text-vscode-fg/80'
                              }`}
                          >
                            <div className="min-w-0 pr-2">
                              <div className="truncate">{m.name || m.id}</div>
                              <div className="flex items-center space-x-1 mt-0.5 text-[8px] text-vscode-fg/40 font-mono">
                                <span>{m.context_length ? `${Math.round(m.context_length / 1000)}k ctx` : 'unlimited'}</span>
                                <span>•</span>
                                <span>{getPriceCategory(m)}</span>
                              </div>
                            </div>
                            {isSelected && <Check className="w-3 h-3 text-vscode-activeBorder shrink-0 mt-0.5" />}
                          </button>
                        );
                      })
                    ) : (
                      <div className="p-2 text-[9px] text-vscode-fg/40 text-center">No models found</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Reasoning selector (if model supports reasoning - Opens Upward) */}
            {modelSupportsReasoning(model) && (
              <div className="relative" ref={thinkingDropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsThinkingDropdownOpen(!isThinkingDropdownOpen)}
                  className="flex items-center space-x-0.5 px-1 py-0.5 rounded bg-vscode-inputBg/85 border border-vscode-inputBorder/40 text-[9px] text-vscode-fg/75 hover:bg-vscode-inputBg transition-all cursor-pointer font-semibold"
                  title="Reasoning effort"
                >
                  <Sparkles className="w-2.5 h-2.5 text-amber-400" />
                  <span className="capitalize">{thinkingEffort}</span>
                  <ChevronDown className="w-2.5 h-2.5 text-vscode-fg/40" />
                </button>
                {isThinkingDropdownOpen && (
                  <div className="absolute bottom-full right-0 mb-1.5 w-[90px] bg-vscode-inputBg border border-vscode-inputBorder/80 rounded-lg shadow-xl z-50 text-[10px] py-0.5 animate-fade-in">
                    {(['none', 'low', 'medium', 'high'] as const).map((effort) => {
                      const isActive = thinkingEffort === effort;
                      return (
                        <button
                          key={effort}
                          type="button"
                          onClick={() => {
                            setThinkingEffort(effort);
                            vscode.postMessage({ type: 'updateThinkingEffort', thinkingEffort: effort });
                            setIsThinkingDropdownOpen(false);
                          }}
                          className={`w-full text-left px-2.5 py-1 hover:bg-vscode-bg transition-colors flex items-center justify-between cursor-pointer capitalize font-bold ${isActive ? 'text-amber-400' : 'text-vscode-fg/80'
                            }`}
                        >
                          <span>{effort}</span>
                          {isActive && <Check className="w-2.5 h-2.5 text-amber-400" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Reset Chat button */}
            <button
              type="button"
              onClick={resetChat}
              className="p-1 rounded hover:bg-vscode-inputBg text-vscode-fg/60 hover:text-white transition-colors cursor-pointer"
              title="Reset conversation"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Floating attachment badges if any */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-0.5 animate-fade-in">
            {attachments.map((att) => {
              const isImg = att.type === 'image';
              return (
                <div
                  key={att.id}
                  className="flex items-center space-x-1 bg-vscode-inputBg/70 border border-vscode-inputBorder/55 pl-1 pr-0.5 py-0.5 rounded text-[9.5px] text-vscode-fg/80 max-w-[130px] shadow-sm select-none"
                >
                  {isImg ? (
                    <img src={att.content} className="w-3.5 h-3.5 object-cover rounded shrink-0" alt="Attachment" />
                  ) : (
                    <FileText className="w-3 h-3 text-vscode-fg/50 shrink-0" />
                  )}
                  <span className="truncate">{att.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== att.id))}
                    className="p-0.5 rounded hover:bg-vscode-bg text-vscode-fg/40 hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Row 2: Input Textarea & Send button */}
        <div className="flex items-end space-x-1.5 bg-vscode-inputBg/65 rounded-lg border border-vscode-inputBorder/60 pl-2 pr-1.5 py-1 focus-within:border-vscode-activeBorder transition-all shadow-inner">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-1 rounded hover:bg-vscode-bg text-vscode-fg/50 hover:text-white transition-colors cursor-pointer shrink-0 mb-0.5"
            title="Attach file or image"
          >
            <Paperclip className="w-3.5 h-3.5" />
          </button>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            className="hidden"
            multiple
          />

          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyPress}
            onPaste={handlePaste}
            placeholder={
              mode === 'agent'
                ? "Ask the Agent to create or change code..."
                : "Ask anything about the workspace..."
            }
            className="flex-1 bg-transparent text-vscode-inputFg border-0 resize-none outline-none py-0.5 text-xs leading-relaxed max-h-[140px] min-h-[22px] focus:ring-0 placeholder:text-vscode-fg/40"
          />

          {isLlmActive ? (
            <button
              type="button"
              onClick={handleStopMessage}
              className="p-1 rounded bg-red-700 hover:bg-red-600 text-white transition-colors cursor-pointer shrink-0 mb-0.5 flex items-center justify-center"
              title="Stop generation"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSendMessage}
              disabled={!input.trim() && attachments.length === 0}
              className={`p-1 rounded transition-all shrink-0 mb-0.5 flex items-center justify-center ${input.trim() || attachments.length > 0
                  ? 'bg-vscode-buttonBg hover:bg-vscode-buttonHoverBg text-white cursor-pointer'
                  : 'bg-vscode-bg text-vscode-fg/30 cursor-not-allowed border border-vscode-inputBorder/30'
                }`}
              title="Send message"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Pricing / Token stats bar */}
        {usage && (() => {
          const activeModel = modelsList.find((m) => m.id === model);
          const contextLimit = activeModel?.context_length || 0;
          const usedTokens = (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0);
          const contextPct = contextLimit > 0 ? Math.min(100, (usedTokens / contextLimit) * 100) : 0;
          const ctxColor =
            contextPct >= 90 ? 'text-red-400' :
            contextPct >= 70 ? 'text-amber-400' :
            'text-emerald-400';
          return (
            <div className="flex items-center justify-between px-2 py-1 bg-vscode-inputBg/15 border border-vscode-inputBorder/15 rounded text-vscode-fg/40 font-mono select-none animate-fade-in">
              <div className="flex items-center space-x-2.5">
                <div className="flex items-center space-x-1" title={`Prompt tokens: ${usage.input}`}>
                  <ArrowDown className="h-3 w-3 text-cyan-400" />
                  <span className="text-[9px]">{usage.input}</span>
                </div>
                <div className="flex items-center space-x-1" title={`Completion tokens: ${usage.output}`}>
                  <ArrowUp className="h-3 w-3 text-purple-400" />
                  <span className="text-[9px]">{usage.output}</span>
                </div>
                {contextLimit > 0 && (
                  <div className={`flex items-center space-x-1 ${ctxColor} font-semibold`} title={`Context window usage: ${contextPct.toFixed(1)}%`}>
                    <Gauge className="h-3 w-3" />
                    <span className="text-[9px]">{contextPct.toFixed(0)}%</span>
                    <div className="relative w-12 h-1 bg-vscode-bg/60 rounded-full overflow-hidden border border-vscode-inputBorder/30">
                      <div
                        className={`h-full transition-all duration-300 ${
                          contextPct >= 90 ? 'bg-red-500' :
                          contextPct >= 70 ? 'bg-amber-500' :
                          'bg-emerald-500'
                        }`}
                        style={{ width: `${contextPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
              {usage.cacheRead > 0 && (
                <div className="flex items-center space-x-1 text-emerald-400 font-semibold" title={`Cached tokens: ${usage.cacheRead}`}>
                  <Database className="h-3 w-3" />
                  <span className="text-[9px]">{usage.cacheRead}</span>
                </div>
              )}
            </div>
          );
        })()}
      </footer>
    </div>
  );
}
