# Feishu CLI Bridge Claude Compatibility Design (2026-03-27)

## Goal
Enhance `feishu-cli-bridge` so Claude can connect to Feishu directly while preserving Codex compatibility and enabling long-term public use.

## Scope and Constraints
- Keep a **single codebase** with configurable backend (`codex` / `claude`).
- Set **Claude as default** for new users.
- Preserve existing Codex workflow via separate env/profile.
- Ensure production-safe docs for public GitHub users.
- Support side-by-side operation of two bots without state collision.

## Recommended Approach
Use **configuration-driven dual backend** (existing architecture) and make Claude the default in docs and examples.

### Why this approach
- Lowest maintenance burden versus separate Claude fork.
- Minimal code risk: existing backend switch stays intact.
- Best public compatibility: one project, two backends, clear setup paths.

## Architecture
### Backend selection
- Continue selecting runner at startup:
  - `BRIDGE_BACKEND=claude` -> `runClaudeReply`
  - `BRIDGE_BACKEND=codex` -> `runCodexReply`
- Keep implementation parity in prompt/history/media handling.

### Configuration model
- Keep both backend config sections in `src/config.js`.
- Default-facing examples move to Claude-first values.
- Preserve explicit Codex config keys for backward compatibility.

### Runtime isolation for coexistence
For concurrent dual-bot deployment:
- Separate env files per bot.
- Separate `DATA_DIR` per process.
- Separate `FEISHU_ACCOUNT_ID` per bot account.
This prevents lock/session/dedupe collisions.

## Components and Required Changes
1. **Docs (`README.md`)**
   - Reframe project as Feishu frontend for both Codex and Claude.
   - Make quick start Claude-first.
   - Add explicit "Run Codex and Claude side-by-side" section.
   - Document isolation requirements and env templates.

2. **Env examples (`.env.example`)**
   - Set default `BRIDGE_BACKEND=claude`.
   - Keep Codex variables present and documented.
   - Add safer guidance comments for shared/public setup.

3. **Config and runner validation**
   - Validate no regressions in `src/config.js`, `src/index.js`, `src/claude-runner.js`.
   - Keep CLI invocation stable (`claude -p --output-format json ...`).

4. **Operational verification**
   - `npm run check` must pass.
   - Startup logs confirm selected backend and Feishu WS readiness.
   - At least one inbound->Claude->Feishu text roundtrip succeeds.

## Data Flow
1. Feishu event received.
2. Bridge deduplicates and queues by peer.
3. Selected backend runner generates reply.
4. Reply text and media markers parsed.
5. Feishu adapter sends chunks/media.
6. Session history persisted.

No data-flow changes are required; only backend-default and public-facing clarity changes.

## Error Handling
- Keep existing timeout/error behavior in runner processes.
- Preserve non-zero exit propagation and user-safe error text.
- Preserve lock and dedupe protections to avoid duplicate replies.

## Testing Strategy
- Static checks: `npm run check`.
- Functional checks:
  - Claude backend startup with env file.
  - Send text in Feishu and verify bot response.
  - Optional media marker return test.
- Compatibility check:
  - Start Codex profile separately and verify unchanged behavior.

## Security and Publishing Requirements
- Never commit real bot credentials.
- Keep real secrets only in local `.env.*` ignored by git.
- Ensure `.env.example` remains placeholder-only.
- Ensure README examples are safe for public reuse.

## Success Criteria
- Public repo supports both backends with clear setup docs.
- Default path is Claude, with Codex still available.
- Two bots can run concurrently via isolated env/data settings.
- Verification evidence confirms end-to-end Claude Feishu direct operation.
