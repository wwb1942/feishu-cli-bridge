<div align="center">

# feishu-cli-bridge

**Feishu Frontend for direct Codex CLI execution**

*Forward Feishu bot messages to your local Codex CLI, execute on the real machine, send results back.*

[![Built with Codex](https://img.shields.io/badge/Built%20with-Codex-1f6feb)](https://github.com/openai/codex)
[![Runtime](https://img.shields.io/badge/Runtime-Node%2022-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Interface](https://img.shields.io/badge/Interface-Feishu-00B96B)](https://www.feishu.cn/)
[![Backend](https://img.shields.io/badge/Backend-Codex%20CLI-black)](https://github.com/openai/codex)

</div>

---

## What This Is

A standalone Feishu frontend for `codex exec`.

It does **not** depend on OpenClaw bindings or JARVIS routing. The bridge opens a Feishu WebSocket connection using your bot app credentials, receives direct messages, stores short per-user history locally, calls `codex exec`, and sends the reply back to the same Feishu conversation.

> **Core rule:** one Feishu bot = one Codex bridge process = one local Codex execution environment.

---

## What You Get

| Feature | Description |
|---|---|
| **Direct Feishu bridge** | Receives `im.message.receive_v1` over Feishu WebSocket |
| **Real Codex execution** | Runs `codex exec` on the machine that owns files and credentials |
| **Session continuity** | Per-peer JSON history under `data/sessions/` |
| **Inbound media download** | Feishu images/files are saved locally and exposed to Codex |
| **Outbound media send** | Codex can return `[[image:/abs/path]]` / `[[file:/abs/path]]` markers |
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
- Image attachments are also passed into `codex exec` via `--image`.
- Pure placeholder media events like `[image]` are queued and merged with the next real text message from the same user.
- Duplicate inbound Feishu events are deduplicated with persisted state plus per-event atomic claim files, so retries, short restarts, and accidental multi-process overlap do not replay the same user message.
- Assistant-originated `im.message.receive_v1` events are ignored, so the bot does not consume its own outbound replies.
- Inbound event callbacks are acknowledged immediately and processed asynchronously in-process, reducing Feishu retries when attachment download or Codex execution is slow.
- Only one bridge process may hold the `DATA_DIR/bridge.lock` instance lock at a time. A second copy exits instead of double-consuming the same Feishu stream.

Outbound:
- If Codex wants to send media back, it should emit markers in the final text:

```text
[[image:/absolute/path/to/image.png]]
[[file:/absolute/path/to/report.pdf]]
```

- Keep any normal user-facing text outside those marker lines.
- Image questions use a shorter history window and lower reasoning effort by default to avoid long stalls.

---

## Environment Variables

Required:

```dotenv
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
```

Optional:

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

DATA_DIR=/root/projects/wechat-codex-bridge/data/default
PROJECT_ROOT=/root/projects/wechat-codex-bridge
```

---

## Project Structure

| File | Purpose |
|---|---|
| `src/feishu-adapter.js` | Feishu WebSocket + media download/upload + send/reply adapter |
| `src/launcher.js` | Cross-platform env-file loader and bridge launcher |
| `src/codex-runner.js` | Launches `codex exec` with rolling history and image attachments |
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
- On Windows, the default `CODEX_BIN` is `codex.cmd`; on Unix-like systems it defaults to `codex`.
- `run-feishu-direct.ps1` is provided as a native PowerShell launcher for Windows.
- `run-feishu-direct.sh` remains as a Unix convenience wrapper only.
- The previous Linux-only `/proc` lock dependency has been removed.
