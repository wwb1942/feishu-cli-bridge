<div align="center">

# feishu-cli-bridge

**Feishu frontend for local Claude CLI and Codex CLI execution**

*Forward Feishu bot messages to your local machine, execute them with Claude or Codex, and send the results back to Feishu.*

[![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-7C3AED)](https://claude.ai/code)
[![Runtime](https://img.shields.io/badge/Runtime-Node%2022-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Interface](https://img.shields.io/badge/Interface-Feishu-00B96B)](https://www.feishu.cn/)
[![Backend](https://img.shields.io/badge/Backend-Claude%20%2F%20Codex-black)](https://github.com/wwb1942/feishu-cli-bridge)

</div>

---

## What This Is

A standalone Feishu bridge for local CLI agents.

The bridge opens a Feishu WebSocket connection using your bot app credentials, receives messages, stores short local history per conversation, calls either `claude -p` or `codex exec`, and sends the reply back to the same Feishu chat.

> **Core rule:** one Feishu bot = one bridge process = one local execution environment.

---

## Prerequisites

Before starting, make sure the host machine has:

- Node.js 22 or newer
- A Feishu self-built app with bot access and valid `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
- A locally installed and authenticated `claude` CLI or `codex` CLI
- Local filesystem access to the workspace you want the bot to operate on

---

## What You Get

| Feature | Description |
|---|---|
| **Direct Feishu bridge** | Receives `im.message.receive_v1` over Feishu WebSocket |
| **Selectable CLI backend** | Runs either `claude -p` or `codex exec` on the machine that owns files and credentials |
| **Session continuity** | Per-session JSON history under `data/sessions/` |
| **Inbound media download** | Feishu images/files are saved locally and exposed to the selected backend |
| **Outbound media send** | The backend can return `[[image:/abs/path]]` / `[[file:/abs/path]]` markers |
| **Opt-in group delegation** | Supports explicit protocol-marked delegated tasks in Feishu groups |
| **Dedicated bot profile** | Separate env file and launcher for isolated bot deployments |

---

## Quick Start

1. Clone the repo and install dependencies:

```bash
git clone https://github.com/wwb1942/feishu-cli-bridge.git
cd feishu-cli-bridge
npm install
```

2. Create a Feishu app in the [Feishu Open Platform Developer Console](https://open.feishu.cn/app), then copy the app credentials from the console.

3. Prepare an env file:

```bash
cp .env.example .env.feishu-direct
```

4. Fill in the Feishu credentials and choose a backend:

```dotenv
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
BRIDGE_BACKEND=claude
```

Switch to Codex backend:

```dotenv
BRIDGE_BACKEND=codex
```

5. Start the bridge:

```bash
node src/launcher.js .env.feishu-direct
```

Or use npm:

```bash
npm run start:feishu
```

Windows PowerShell convenience wrapper:

```powershell
./run-feishu-direct.ps1
```

Unix/macOS convenience wrapper:

```bash
./run-feishu-direct.sh
```

---

## Media Protocol

Inbound:

- Feishu image/file messages are downloaded into the local `data/media/` tree.
- Image attachments are also passed into `codex exec` via `--image` when using the Codex backend.
- Pure placeholder media events like `[image]` are queued and merged with the next real text message from the same user.
- Duplicate inbound Feishu events are deduplicated with persisted state plus per-event atomic claim files, so retries, short restarts, and accidental multi-process overlap do not replay the same user message.
- Assistant-originated `im.message.receive_v1` events are ignored by default; when group delegation is enabled, only assistant messages with a valid leading protocol marker are forwarded.
- Inbound event callbacks are acknowledged immediately and processed asynchronously in-process, reducing Feishu retries when attachment download or CLI execution is slow.
- Only one bridge process may hold the `DATA_DIR/bridge.lock` instance lock at a time. A second copy exits instead of double-consuming the same Feishu stream.

Outbound:

- If the backend wants to send media back, it should emit markers in the final text:

```text
[[image:/absolute/path/to/image.png]]
[[file:/absolute/path/to/report.pdf]]
```

- Keep any normal user-facing text outside those marker lines.
- Media-heavy questions use a shorter retained history window to avoid long stalls.

---

## Environment Variables

### Required

```dotenv
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
```

### Core Runtime

```dotenv
BRIDGE_BACKEND=claude
PROJECT_ROOT=/path/to/feishu-cli-bridge
DATA_DIR=/path/to/feishu-cli-bridge/data/default
```

### Feishu

```dotenv
FEISHU_DOMAIN=feishu
FEISHU_ENCRYPT_KEY=
FEISHU_VERIFICATION_TOKEN=
FEISHU_ACCOUNT_ID=custom-1
FEISHU_REPLY_CHUNK_CHARS=1400
FEISHU_MAX_INBOUND_BYTES=31457280
FEISHU_INBOUND_DEDUP_WINDOW_MS=12000
FEISHU_INBOUND_PROCESSING_TTL_MS=300000
FEISHU_INBOUND_REPLIED_TTL_MS=86400000
```

### Claude Backend

```dotenv
CLAUDE_BIN=claude
CLAUDE_MODEL=
CLAUDE_EFFORT=
CLAUDE_WORKDIR=/path/to/your/workspace
CLAUDE_HISTORY_LIMIT=12
CLAUDE_IMAGE_HISTORY_LIMIT=4
CLAUDE_TIMEOUT_MS=240000
CLAUDE_ALLOWED_TOOLS=Read,Glob,Grep,Bash
CLAUDE_ADD_DIRS=
CLAUDE_BRIDGE_SYSTEM_PROMPT=You are Claude in a Feishu bot bridge running on the user machine. Reply concisely and helpfully in plain text. Reply with final user-facing text only. Do not mention skills, workflow, or internal process. If you want to return media, emit one marker per line: [[image:/absolute/path]] or [[file:/absolute/path]].
```

### Codex Backend

```dotenv
CODEX_BIN=codex
CODEX_MODEL=gpt-5.4
CODEX_REASONING_EFFORT=low
CODEX_SANDBOX=workspace-write
CODEX_WORKDIR=/path/to/your/workspace
CODEX_HISTORY_LIMIT=12
CODEX_MAX_IMAGE_ATTACHMENTS=4
CODEX_IMAGE_HISTORY_LIMIT=4
CODEX_TIMEOUT_MS=180000
CODEX_MAX_IMAGE_DIMENSION=1280
CODEX_BRIDGE_SYSTEM_PROMPT=You are Codex in a Feishu bot bridge. Reply concisely and helpfully in plain text. If you want to return media, emit one marker per line: [[image:/absolute/path]] or [[file:/absolute/path]].
```

Replace those path examples with real paths on your own machine. `CLAUDE_WORKDIR` and `CODEX_WORKDIR` are the default working directories for agent execution, while `PROJECT_ROOT` and `DATA_DIR` point at the bridge project and its local runtime data.

Notes:

- `BRIDGE_BACKEND=claude` expects a working local `claude` CLI that is already authenticated and configured.
- `BRIDGE_BACKEND=codex` expects a working local `codex` CLI that is already authenticated and configured.
- `CLAUDE_ALLOWED_TOOLS` is the main switch that decides whether Claude can actually read files or run shell commands from Feishu requests.

---

## Multi-Bot Deployment

Run Claude and Codex side-by-side safely:

- Use separate Feishu bot app credentials
- Use separate env files such as `.env.feishu-claude` and `.env.feishu-codex`
- Use separate `FEISHU_ACCOUNT_ID` values
- Use separate `DATA_DIR` values to avoid lock, session, and dedupe collisions
- Run each profile as a separate process

---

## Project Structure

| File | Purpose |
|---|---|
| `src/feishu-adapter.js` | Feishu WebSocket, media download/upload, and send/reply adapter |
| `src/bridge-app.js` | Bridge bootstrap, inbound dedupe, claim handling, and media merge flow |
| `src/bridge-runtime.js` | Route-aware runtime for direct chat and delegated task execution |
| `src/launcher.js` | Cross-platform env-file loader and bridge launcher |
| `src/codex-runner.js` | Launches `codex exec` with rolling history and image attachments |
| `src/claude-runner.js` | Launches `claude -p` with explicit tool allowances and JSON parsing |
| `src/runner-utils.js` | Shared prompt builder and media marker parser |
| `src/session-store.js` | JSON storage for conversations, inbound claims, and process lock state |
| `src/config.js` | Environment/config loader |
| `src/index.js` | Bridge entrypoint |
| `run-feishu-direct.ps1` | Windows PowerShell launcher for dedicated bot profiles |
| `run-feishu-direct.sh` | Unix/macOS launcher for dedicated bot profiles |

---

## Contributing

Issues and pull requests are welcome.

- Open an issue first for larger changes or behavior changes.
- Keep secrets, env files, and runtime data out of git.
- Run `npm test` and `npm run check` before sending a PR.

---

## Acknowledgment

Initial project framing and some README conventions were inspired by [telegram-cli-bridge](https://github.com/AliceLJY/telegram-cli-bridge). This repository is implemented as a standalone Feishu bridge with a different runtime architecture and local CLI execution through `claude -p` or `codex exec`.

---

## License

This repository does not currently include a `LICENSE` file. Until one is added, treat the code as not yet licensed for general redistribution or reuse.

---

## Security

- Never commit `.env.feishu-direct`, `.env.local`, or any real credential file.
- Keep bot credentials only in local env files or your process manager.
- `data/`, `.wechat-codex-bridge/`, `node_modules/`, and `*.bak.*` are excluded from git.
- Before publishing, run a quick secret scan on the repo and verify only placeholder values remain in `.env.example`.

---

## Platform Notes

- The bridge core is cross-platform at the Node.js level.
- `node src/launcher.js <env-file>` is the recommended startup path on Linux, macOS, and Windows.
- On Windows, defaults are `CODEX_BIN=codex.cmd` and `CLAUDE_BIN=claude.cmd`; on Unix-like systems they default to `codex` and `claude`.
- `run-feishu-direct.ps1` is provided as a native PowerShell launcher for Windows.
- `run-feishu-direct.sh` remains as a Unix convenience wrapper.
- The previous Linux-only `/proc` lock dependency has been removed.
