
# Architecture Overview

## Project Summary

**Code Master** is a VS Code extension that provides:

- A sidebar-based AI assistant UI
- Two interaction modes:
  - **Chat mode** for direct conversational responses
  - **Agent mode** for autonomous, tool-driven code analysis and modification
- A React-based webview frontend embedded in VS Code
- An extension-host backend that manages:
  - model communication through OpenRouter
  - autonomous tool execution
  - file and command approval workflows
  - attachment parsing
  - workspace-aware operations

At a high level, the project is a **desktop extension application** composed of two main runtime layers:

1. **VS Code Extension Host backend**  
   Runs in Node.js inside VS Code and has access to the workspace, filesystem, commands, and webview APIs.

2. **Webview frontend**  
   A React + Vite application rendered inside the sidebar view, used for chat interaction, controls, and tool approval UX.

---

## Top-Level Structure

```text
.
├── package.json                  # VS Code extension manifest, scripts, dependencies
├── tsconfig.json                 # TypeScript config for extension-side code
├── src/
│   ├── extension.ts              # Extension activation, webview provider, orchestration
│   ├── services/
│   │   ├── agent.ts              # Autonomous agent loop, tool parsing/execution, approvals
│   │   └── llm.ts                # OpenRouter streaming client and message utilities
│   └── webview/
│       ├── package.json          # Webview app package definition
│       ├── vite.config.ts        # Vite build configuration
│       ├── postcss.config.js     # PostCSS config
│       ├── tailwind.config.js    # Tailwind config
│       ├── index.html            # Webview entry HTML
│       ├── assets/
│       │   └── logo.png          # Shared branding asset
│       └── src/
│           ├── main.tsx          # React bootstrap
│           ├── App.tsx           # Main UI and interaction logic
│           └── index.css         # Tailwind / global styling
├── .vscode/
│   ├── launch.json               # Debug config
│   └── tasks.json                # Task config
└── .cm_reports/
    └── changes.md                # Generated change summary artifact
```

---

## Core Technologies

### Backend / Extension Host
- **TypeScript**
- **VS Code Extension API**
- **Node.js built-ins**
  - `fs`
  - `path`
  - `https`
  - `child_process`
- **esbuild** for bundling the extension entrypoint
- **OpenRouter API** for model access
- **pdf-parse** for PDF text extraction
- **xlsx** for spreadsheet parsing

### Frontend / Webview
- **React 18**
- **TypeScript**
- **Vite**
- **Tailwind CSS**
- **PostCSS + Autoprefixer**
- **react-markdown** for rendering assistant responses
- **lucide-react** for UI icons

### Packaging / Development
- **VSIX-compatible VS Code extension structure**
- **concurrently** for parallel watch processes
- **npm** for dependency and build orchestration

---

## Architectural Style

The application follows a **split frontend/backend extension architecture**:

- The **webview** is the presentation layer
- The **extension host** is the application/service layer
- The **agent** is a domain-specific orchestration engine for autonomous work
- The **LLM service** is an infrastructure adapter for streaming model communication

This creates a layered structure:

```text
Webview UI (React)
    ⇅ postMessage
Extension Host Controller (extension.ts)
    ⇅ direct service calls
Agent Runtime (agent.ts)
    ⇅
LLM Adapter (llm.ts)
    ⇅
OpenRouter API
```

Additionally, the extension host directly integrates with:
- the local filesystem
- workspace metadata
- VS Code UI commands
- diff views
- markdown previews
- terminal command execution

---

## Main Runtime Components

## 1. Extension Entry and Controller Layer

**Primary file:** `src/extension.ts`

This file is the central application controller for the extension host.

### Responsibilities
- Activates the extension
- Registers the sidebar webview provider
- Registers the reset command
- Tracks workspace changes
- Hosts webview/backend messaging
- Maintains non-agent chat history
- Chooses between direct chat mode and agent mode
- Loads API keys from `.env`
- Fetches available models from OpenRouter
- Parses non-image attachments before sending to models
- Opens VS Code diff views for file proposals

### Important constructs

#### `activate(context)`
Creates:
- an `Agent` instance
- a `CodeMasterChatViewProvider` instance

Registers:
- `code-master.chatView` webview view provider
- `code-master.resetChat` command
- workspace-folder change listener

#### `CodeMasterChatViewProvider`
This is the main controller class connecting the UI to backend services.

It owns:
- current view reference
- chat message state for direct chat mode
- selected provider/model/mode
- reasoning effort
- active abort controller
- cached model list

### Key behaviors
- Sends initial state when the webview reports it is ready
- Receives UI messages like:
  - `sendMessage`
  - `updateModel`
  - `updateMode`
  - `toolDecision`
  - `viewDiff`
  - `stopGeneration`
  - `resetChat`
- Routes requests to:
  - direct streaming chat
  - autonomous agent execution

### Architectural note
`extension.ts` acts as a **controller/facade**, while `agent.ts` and `llm.ts` contain the main execution and integration logic.

---

## 2. Agent Runtime

**Primary file:** `src/services/agent.ts`

This is the most important domain-specific component in the project. It implements an autonomous coding agent that can inspect the workspace, reason iteratively, invoke tools, and wait for human approval for sensitive actions.

### Responsibilities
- Maintain agent conversation history
- Build an agent-specific system prompt
- Stream assistant responses from the LLM
- Parse embedded XML-like tool calls from model output
- Execute tools sequentially
- Pause for user approvals where needed
- Push tool results back into the conversation as system messages
- Detect repeated tool loops
- Support cancellation
- Render agent-friendly UI messages

### Agent execution model

The agent uses a **loop-based orchestration design**:

1. Add user message to internal history
2. Call the LLM with:
   - conversation history
   - system prompt
   - optional architecture context
   - optional active editor context
3. Stream response tokens
4. Parse any tool tags in the assistant response
5. If no tools were called:
   - finish and return final answer
6. If tools were called:
   - execute them in order
   - append each tool result as a `system` message
   - continue the loop so the model can react to the results

This is a standard **ReAct-style agent loop**, but implemented through custom XML tags rather than JSON function calling.

### Internal state
The `Agent` stores:
- `messages`
- `workspaceRoot`
- pending approval resolver
- current pending tool
- tool sequence counter
- abort controller
- cumulative token usage

### Human-in-the-loop controls
The agent intentionally requires explicit approval for:
- `write_file`
- `edit_file`
- unsafe `run_command`

For write/edit operations it also:
- creates temp files
- opens a diff comparison
- generates a markdown plan preview
- writes a post-approval change summary

This reflects a **safety-first agent architecture**.

---

## 3. Tooling Model

The agent supports a custom XML command protocol:

- `<list_files />`
- `<read_file />`
- `<search_code />`
- `<write_file>...