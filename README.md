<div align="center">

# feishu-cli-bridge

**Feishu Frontend for direct Claude Code and Codex CLI execution**

*Forward Feishu bot messages to your local Claude Code CLI (default) or Codex CLI, execute on the real machine, send results back.*

[![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-7C3AED)](https://claude.ai/code)
[![Runtime](https://img.shields.io/badge/Runtime-Node%2022-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Interface](https://img.shields.io/badge/Interface-Feishu-00B96B)](https://www.feishu.cn/)
[![Backend](https://img.shields.io/badge/Backend-Claude%20(default)%20%2B%20Codex%20compatible-black)](https://github.com/wwb1942/feishu-cli-bridge)

</div>

---

## What This Is

A standalone Feishu frontend for local CLI agents.

It does **not** depend on OpenClaw bindings or JARVIS routing. The bridge opens a Feishu WebSocket connection using your bot app credentials, receives direct messages, stores short per-user history locally, calls either `codex exec` or `claude -p`, and sends the reply back to the same Feishu conversation.

> **Core rule:** one Feishu bot = one bridge process = one local execution environment.

---

## What You Get

| Feature | Description |
|---|---|
| **Direct Feishu bridge** | Receives `im.message.receive_v1` over Feishu WebSocket |
| **Selectable CLI backend** | Runs either `codex exec` or `claude -p` on the machine that owns files and credentials |
| **Session continuity** | Per-peer JSON history under `data/sessions/` |
| **Inbound media download** | Feishu images/files are saved locally and exposed to the selected backend |
| **Outbound media send** | The backend can return `[[image:/abs/path]]` / `[[file:/abs/path]]` markers |
| **Dedicated bot profile** | Separate env file and launcher for an isolated bot |

---

## Quick Start

```bash
git clone https://github.com/wwb1942/feishu-cli-bridge.git
cd feishu-cli-bridge
npm install
```

Prepare environment:

```bash
cp .env.example .env.feishu-direct
```

Fill in your Feishu app credentials, then run:

```bash
node src/launcher.js .env.feishu-direct
```

Choose backend in the env file (default is Claude):

```dotenv
BRIDGE_BACKEND=claude
```

Codex compatibility mode:

```dotenv
BRIDGE_BACKEND=codex
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
- Assistant-originated `im.message.receive_v1` events are ignored, so the bot does not consume its own outbound replies.
- Inbound event callbacks are acknowledged immediately and processed asynchronously in-process, reducing Feishu retries when attachment download or Codex execution is slow.
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

Required:

```dotenv
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
```

Optional:

```dotenv
BRIDGE_BACKEND=claude

FEISHU_DOMAIN=feishu
FEISHU_ENCRYPT_KEY=
FEISHU_VERIFICATION_TOKEN=
FEISHU_ACCOUNT_ID=custom-1
FEISHU_REPLY_CHUNK_CHARS=1400
FEISHU_MAX_INBOUND_BYTES=31457280
FEISHU_INBOUND_DEDUP_WINDOW_MS=12000
FEISHU_INBOUND_PROCESSING_TTL_MS=300000
FEISHU_INBOUND_REPLIED_TTL_MS=86400000

CODEX_BIN=codex
CODEX_MODEL=gpt-5.4
CODEX_REASONING_EFFORT=low
CODEX_SANDBOX=workspace-write
CODEX_WORKDIR=/root/projects/wechat-codex-bridge
CODEX_HISTORY_LIMIT=12
CODEX_MAX_IMAGE_ATTACHMENTS=4
CODEX_IMAGE_HISTORY_LIMIT=4
CODEX_TIMEOUT_MS=180000
CODEX_MAX_IMAGE_DIMENSION=1280
CODEX_BRIDGE_SYSTEM_PROMPT=You are Codex in a Feishu bot bridge. Reply concisely and helpfully in plain text. If you want to return media, emit one marker per line: [[image:/absolute/path]] or [[file:/absolute/path]].

CLAUDE_BIN=claude
CLAUDE_MODEL=
CLAUDE_EFFORT=
CLAUDE_WORKDIR=/root/projects/wechat-codex-bridge
CLAUDE_HISTORY_LIMIT=12
CLAUDE_IMAGE_HISTORY_LIMIT=4
CLAUDE_TIMEOUT_MS=240000
CLAUDE_ALLOWED_TOOLS=Read,Glob,Grep,Bash
CLAUDE_ADD_DIRS=
CLAUDE_BRIDGE_SYSTEM_PROMPT=You are Claude in a Feishu bot bridge running on the user machine. Reply concisely and helpfully in plain text. Reply with final user-facing text only. Do not mention skills, workflow, or internal process. If you want to return media, emit one marker per line: [[image:/absolute/path]] or [[file:/absolute/path]].

DATA_DIR=/root/projects/wechat-codex-bridge/data/default
PROJECT_ROOT=/root/projects/wechat-codex-bridge
```

Run Claude and Codex side-by-side safely:
- Use separate Feishu bot app credentials (different bot app IDs).
- Use separate env files (for example `.env.feishu-claude` and `.env.feishu-codex`).
- Use separate `FEISHU_ACCOUNT_ID` values.
- Use separate `DATA_DIR` values to avoid lock/session/dedupe collisions.
- Run each profile as a separate process.

Notes:
- `BRIDGE_BACKEND=claude` expects a working local `claude` CLI that is already authenticated and configured.
- `BRIDGE_BACKEND=codex` keeps compatibility with existing Codex-based deployments.
- `CLAUDE_ALLOWED_TOOLS` is the main switch that decides whether Claude can actually read files or run shell commands from Feishu requests.

---

## Project Structure

| File | Purpose |
|---|---|
| `src/feishu-adapter.js` | Feishu WebSocket + media download/upload + send/reply adapter |
| `src/launcher.js` | Cross-platform env-file loader and bridge launcher |
| `src/codex-runner.js` | Launches `codex exec` with rolling history and image attachments |
| `src/claude-runner.js` | Launches `claude -p` with explicit tool allowances and JSON parsing |
| `src/runner-utils.js` | Shared prompt builder and media marker parser |
| `src/session-store.js` | Peer-scoped JSON session store |
| `src/index.js` | Bridge entrypoint and queueing |
| `src/config.js` | Environment/config loader |
| `run-feishu-direct.sh` | Launcher for dedicated bot profiles |

---

## Security

- Never commit `.env.feishu-direct`, `.env.local`, or any real credential file.
- Keep bot credentials only in local env files or your process manager.
- `data/`, `.wechat-codex-bridge/`, `node_modules/`, and `*.bak.*` are excluded from git.
- Before publishing, run a quick secret scan on the repo and verify only placeholder values remain in `.env.example`.

## Platform Notes

- The bridge core is now cross-platform at the Node.js level.
- `node src/launcher.js <env-file>` is the recommended startup path on Linux, macOS, and Windows.
- On Windows, defaults are `CODEX_BIN=codex.cmd` and `CLAUDE_BIN=claude.cmd`; on Unix-like systems they default to `codex` and `claude`.
- `run-feishu-direct.ps1` is provided as a native PowerShell launcher for Windows.
- `run-feishu-direct.sh` remains as a Unix convenience wrapper only.
- The previous Linux-only `/proc` lock dependency has been removed.
