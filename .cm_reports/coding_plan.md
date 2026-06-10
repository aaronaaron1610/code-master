# Proposed Coding Plan

The AI Assistant is proposing to create/overwrite a file.

## Details
- **Action**: Write/Overwrite File
- **Target File**: \`ARCHITECTURE.md\`

## Proposed Content
```md

# Architecture Overview

## Project Summary

**Code Master** is a VS Code extension that provides:

- an **AI chat interface** embedded in the VS Code sidebar
- an **autonomous coding agent** that can inspect files, edit code, write files, and run commands
- a **React-based webview UI** for conversation, approvals, file attachments, model selection, and usage display
- an **LLM integration layer** built on **OpenRouter** with streaming responses and optional reasoning support

The project is split into two major runtime parts:

1. **VS Code extension host backend**
   - Runs in Node.js inside the VS Code extension process
   - Owns workspace access, file IO, command execution, API access, and agent control
2. **Webview frontend**
   - Runs in an isolated browser-like environment inside VS Code
   - Renders the chat UI and sends user actions back to the extension host

---

## High-Level Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                        VS Code Host                          │
│                                                              │
│  ┌──────────────────────┐     postMessage     ┌────────────┐ │
│  │ Extension Host       │ ◄────────────────► │ Webview UI │ │
│  │ src/extension.ts     │                     │ React/Vite │ │
│  └─────────┬────────────┘                     └────────────┘ │
│            │                                                 │
│            │ uses                                            │
│            ▼                                                 │
│  ┌──────────────────────┐                                    │
│  │ Agent Service        │                                    │
│  │ src/services/agent.ts│                                    │
│  └─────────┬────────────┘                                    │
│            │                                                 │
│            │ uses                                            │
│            ▼                                                 │
│  ┌──────────────────────┐                                    │
│  │ LLM Service          │                                    │
│  │ src/services/llm.ts  │                                    │
│  └─────────┬────────────┘                                    │
│            │ HTTPS streaming                                 │
│            ▼                                                 │
│       OpenRouter API                                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Workspace Structure

```text
package.json                 # VS Code extension manifest and build scripts
tsconfig.json                # TypeScript configuration
src/
  extension.ts               # Extension entrypoint and webview host logic
  services/
    agent.ts                 # Autonomous agent loop and tool execution
    llm.ts                   # Streaming LLM client and prompt helpers
  webview/
    package.json             # Webview frontend package manifest
    vite.config.ts           # Vite bundling config
    tailwind.config.js       # Tailwind theme config using VS Code CSS vars
    postcss.config.js        # PostCSS/Tailwind pipeline
    index.html               # Webview HTML shell
    src/
      main.tsx               # React bootstrap
      App.tsx                # Main application UI
      index.css              # Global and theme-aware styling
    assets/
      logo.png               # Branding asset
.cm_reports/
  changes.md                 # Generated summary of applied edits
ARCHITECTURE.md              # Architecture documentation
```

---

## Core Technologies

### Extension Host
- **TypeScript**
- **VS Code Extension API**
- **Node.js built-ins**
  - `fs`
  - `path`
  - `https`
  - `child_process`

### Frontend / Webview
- **React 18**
- **Vite**
- **Tailwind CSS**
- **react-markdown**
- **lucide-react**

### AI / Parsing / Utilities
- **OpenRouter chat completions API**
- **pdf-parse** for PDF attachment parsing
- **xlsx** for Excel attachment parsing

---

## Runtime Components

## 1. Extension Entrypoint (`src/extension.ts`)

This file is the orchestration layer between VS Code, the webview, the agent, and the LLM service.

### Main responsibilities
- Activates the extension
- Registers the sidebar webview view provider
- Registers commands such as reset conversation
- Handles workspace synchronization
- Receives messages from the webview
- Routes requests either to:
  - direct chat mode
  - agent mode
- Manages conversation state for non-agent chat
- Manages model and reasoning selections
- Reads API key configuration from `.env`
- Parses attachments before sending them to the model

### Important class
- `CodeMasterChatViewProvider`

This class owns:
- the current `WebviewView`
- chat history
- selected provider/model/mode
- active abort controller for streaming chat
- model list fetched from OpenRouter

### Notable behaviors
- Uses `retainContextWhenHidden: true` so the webview preserves state
- Watches `dist/webview/assets/*` for development refresh
- Watches `.cm_reports/{ARCHITECTURE,architecture}.md` to update the UI’s architecture discovery state
- Injects the active editor file contents into prompts for additional context

---

## 2. Agent Service (`src/services/agent.ts`)

The `Agent` class implements the autonomous tool-using execution loop.

### Main responsibilities
- Maintains agent conversation history
- Builds the agent system prompt
- Streams LLM output
- Parses tool XML from model responses
- Executes supported tools
- Requests approval for risky actions
- Prevents repeated tool loops
- Returns tool outputs back into the model context as system messages
- Renders agent messages into UI-friendly structures

### Agent loop pattern

The agent follows a cycle like this:

1. User sends a request in **agent mode**
2. The extension host calls `agent.run(...)`
3. The agent sends conversation + system prompt to the LLM
4. The LLM may respond with explanation text plus one XML tool call
5. The agent parses the tool call
6. The tool is executed
7. The result is appended as a system message
8. The loop continues until the LLM stops calling tools

### Supported tools
The agent recognizes and executes these custom XML commands:

- `<list_files/>`
- `<read_file path="..."/>`
- `<search_code query="..."/>`
- `<write_file path="...">...
```
