
# Architecture: Code Master (VS Code Extension)

## 1. Overview

**Code Master** is a VS Code extension that provides an AI chat interface and an *autonomous coding agent* inside a VS Code Webview panel. It communicates with large language models via **OpenRouter** using **streaming Server-Sent Events (SSE)** over HTTPS.  

The architecture is split into two major parts:

1. **Extension Host (Node.js / TypeScript)**  
   - Owns the VS Code UI container (WebviewViewProvider).
   - Implements the **Agent** (tool parsing, tool execution, approval gating).
   - Implements the **LLM streaming client** (OpenRouter SSE parsing).
   - Handles workspace file operations securely (path resolution / workspace boundary checks).
   - Sends state and events to the Webview via `postMessage`.

2. **Webview UI (React + Vite + Tailwind CSS)**  
   - Renders the chat/agent UI.
   - Collects user input, attachments, and UI selections (model, mode, reasoning effort).
   - Displays streaming tokens, tool steps, and approval actions.
   - Sends user decisions back to the extension host via `postMessage`.

---

## 2. Repository / File Structure

Top-level (workspace root):

- `package.json` – extension metadata, dependencies, build scripts
- `tsconfig.json` – TypeScript config
- `src/extension.ts` – extension host entry + WebviewViewProvider + message routing
- `src/services/llm.ts` – OpenRouter streaming + prompt/content utilities
- `src/services/agent.ts` – autonomous agent loop + tool execution implementations
- `src/webview/` – React/Vite webview app
- `.env` (expected in user’s workspace root) – `OPENROUTER_API_KEY`

Notable build output directories (generated):

- `dist/extension.js` – bundled extension host via **esbuild**
- `dist/webview/assets/*` – webview build output via **Vite**

---

## 3. Build & Tooling Technologies

### Extension Host
- **Language**: TypeScript
- **Bundler**: `esbuild`
- **Runtime**: VS Code extension host (Node.js)
- **LLM HTTP**: native `https` module
- **Streaming format**: SSE from OpenRouter

Key scripts in root `package.json`:
- `compile:extension`: bundles `src/extension.ts` → `dist/extension.js`
- `compile:webview`: builds webview from `src/webview` via Vite
- `watch`: concurrently watches extension + webview

### Webview UI
- **Language**: TypeScript + React (TSX)
- **Bundler**: Vite
- **Styling**: Tailwind CSS (with `tailwind.config.js`)
- **Markdown rendering**: `react-markdown`
- **Icons**: `lucide-react`

---

## 4. VS Code Contribution & Webview Surface

### View Registration
In `package.json`, the extension contributes:
- Activity bar view container: `code-master-sidebar`
- Webview view: `code-master.chatView`

### Webview Initialization & Permissions
In `src/extension.ts`:
- `resolveWebviewView()` sets:
  - `enableScripts: true`
  - `localResourceRoots: [extensionUri]`
- HTML loads:
  - `dist/webview/assets/index.js`
  - `dist/webview/assets/index.css`

### Hot Reload Watching (dev convenience)
The extension sets up file watchers:
- `dist/webview/assets/*` – reloads webview HTML if changed
- `**/{ARCHITECTURE,architecture}.md` – informs UI whether architecture file exists

---

## 5. Extension ↔ Webview Communication Contract

### Message Transport
The extension host posts messages to the webview using:
- `webview.postMessage(msg)`

The webview notifies the extension host using:
- `acquireVsCodeApi().postMessage(...)`

### Message Types (Extension → Webview)
- `state`: full UI state snapshot:
  - `messages`, `provider`, `model`, `mode`, `thinkingEffort`
  - `workspacePath`
  - partial key display: `keys.openrouterKey` masked
  - `models` list
  - `architectureExists`
  - optional `usage`
- `activeState`: `{ active: boolean }` for streaming on/off
- `workspace`: `{ path, architectureExists }` on workspace changes
- `architectureState`: `{ exists: boolean }`

### Message Types (Webview → Extension)
- `ready` – triggers `sendInitialState()`
- `saveKeys` – currently routes through `sendInitialState()`
- `updateModel` – updates selected LLM model
- `updateThinkingEffort` – reasoning effort changes (when supported)
- `updateMode` – toggles `chat` vs `agent`
- `sendMessage` – start message handling:
  - `text`
  - `attachments[]` (images as data URLs; files as raw text/binary data URLs)
  - `options`: `{ mode, provider, model, thinkingEffort? }`
- `toolDecision` – approval/rejection for a pending tool:
  - `{ toolId, approve }`
- `viewDiff` – open VS Code diff view for proposed file edits
- `stopGeneration` – abort current generation / stop agent
- `resetChat` – resets conversation and agent state

---

## 6. LLM Streaming (OpenRouter via SSE)

Implemented in `src/services/llm.ts`.

### Request Construction
- Endpoint: `https://openrouter.ai/api/v1/chat/completions`
- Payload:
  - `model`
  - `messages` (system prompt optionally prepended)
  - `stream: true`
  - `stream_options.include_usage: true`

### Reasoning Effort
If the selected model “supports reasoning” (heuristic based on model id containing keywords like `r1`, `o1`, `thinking`, `reasoning`) and `thinkingEffort` is provided:
- `bodyData.reasoning = { effort: thinkingEffort.toLowerCase() }`

### Streaming Parser
- Uses native Node `https.request` with streaming `data` events.
- SSE data is parsed via a small `SseParser`:
  - buffers by newline
  - processes lines that look like `data: ...`
- Stops when it receives `data: [DONE]`.

### Token vs Thought Extraction
From each SSE chunk, the extension tries:
- `delta.reasoning` or `delta.thought` → thought content (if present)
- `delta.content` → standard assistant tokens

### Usage Metrics
When OpenRouter includes usage:
- `prompt_tokens` → input
- `completion_tokens` → output
- `prompt_tokens_details.cached_tokens` → cacheRead
- cacheWrite currently treated as `0`

---

## 7. Agent Architecture (Autonomous Tool-Using Loop)

Implemented in `src/services/agent.ts`.

### Agent Inputs
`Agent.run(...)` receives:
- `userContent`: either a string or LLM content parts
- `attachments`: list of typed attachments
- `options`: `{ provider, model, apiKey, thinkingEffort? }`
- `onStateUpdate`: callback to continuously update UI

### Prompt + Attachment Injection
The agent injects attachments into the prompt by converting them into a formatted “Attached Files” block (using `constructPromptWithFiles`).

### System Prompt
`getSystemPrompt()` instructs the model about:
- the custom XML tool tags:
  - `<list_files />`
  - `<read_file />`
  - `<search_code />`
  - `<write_file>...