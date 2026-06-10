# Summary of Applied Changes

**Timestamp**: 6/10/2026, 12:36:44 PM
**Action**: Write/Overwrite File
**File**: `ARCHITECTURE.md`

## Content Written
```md

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
... [truncated 161 lines]
```
