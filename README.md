# feishu-cli-bridge

Standalone bridge that connects a dedicated Feishu bot directly to Codex CLI without using OpenClaw routing/bindings.

## Current bot profile

A dedicated local profile has been prepared in:

```bash
.env.feishu-direct
```

It uses its own Feishu app credentials and isolated session store under:

```bash
/root/projects/wechat-codex-bridge/data/feishu-direct
```

## Run

```bash
cd /root/projects/wechat-codex-bridge
./run-feishu-direct.sh
```

If you want a different bot profile, copy `.env.example` to a new env file and pass it to the launcher:

```bash
./run-feishu-direct.sh /path/to/your.env
```

## What it does

- Opens a direct Feishu WebSocket event stream with your app credentials
- Receives `im.message.receive_v1` messages
- Stores short conversation history per peer under `data/sessions/`
- Calls `codex exec` directly for each inbound message
- Replies back to the same Feishu conversation

## Notes

- This project does not reuse OpenClaw bindings or JARVIS routing
- It is a direct bot-to-Codex bridge
- WebSocket callback mode must be enabled in the Feishu developer console for the app you use
