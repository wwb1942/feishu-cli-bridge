# Feishu Claude Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `feishu-cli-bridge` Claude-first for new users while preserving full Codex compatibility and safe dual-bot coexistence.

**Architecture:** Keep one runtime and one codebase with backend routing via `BRIDGE_BACKEND`. Change public defaults/docs to Claude, keep Codex path fully intact, and add lightweight automated checks around backend selection/default behavior.

**Tech Stack:** Node.js 22 (ESM), Feishu Node SDK, Claude Code CLI, Codex CLI, built-in `node:test` + `node:assert`.

---

### Task 1: Add automated config tests (default + compatibility)

**Files:**
- Create: `tests/config.test.js`
- Modify: `package.json`
- Test: `tests/config.test.js`

**Step 1: Write the failing test**

```js
// tests/config.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

function withEnv(overrides, fn) {
  const backup = { ...process.env };
  process.env = { ...backup, ...overrides };
  try {
    return fn();
  } finally {
    process.env = backup;
  }
}

test('defaults backend to claude when BRIDGE_BACKEND is unset', async () => {
  const { loadConfig } = await import('../src/config.js');
  const cfg = withEnv({ FEISHU_APP_ID: 'x', FEISHU_APP_SECRET: 'y', BRIDGE_BACKEND: '' }, () => loadConfig());
  assert.equal(cfg.backend, 'claude');
});

test('keeps codex backend when explicitly configured', async () => {
  const { loadConfig } = await import('../src/config.js');
  const cfg = withEnv({ FEISHU_APP_ID: 'x', FEISHU_APP_SECRET: 'y', BRIDGE_BACKEND: 'codex' }, () => loadConfig());
  assert.equal(cfg.backend, 'codex');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL on first test (`'codex' !== 'claude'`).

**Step 3: Add test script for repeatable runs**

```json
{
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
```

**Step 4: Re-run test baseline**

Run: `npm run test`
Expected: still FAIL until config default is changed.

**Step 5: Commit**

```bash
git add tests/config.test.js package.json package-lock.json
git commit -m "test: add backend default and compatibility coverage"
```

---

### Task 2: Make Claude the default backend without breaking Codex path

**Files:**
- Modify: `src/config.js:27-30`
- Test: `tests/config.test.js`

**Step 1: Write minimal implementation**

Replace:

```js
const backend = (process.env.BRIDGE_BACKEND || 'codex').trim().toLowerCase();
```

With:

```js
const backend = (process.env.BRIDGE_BACKEND || 'claude').trim().toLowerCase();
```

**Step 2: Run targeted tests**

Run: `node --test tests/config.test.js`
Expected: PASS for both default-claude and explicit-codex tests.

**Step 3: Run existing syntax checks**

Run: `npm run check`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/config.js tests/config.test.js
git commit -m "feat: default bridge backend to claude"
```

---

### Task 3: Update public env template for Claude-first setup

**Files:**
- Modify: `.env.example`

**Step 1: Write failing documentation assertion (manual check)**

Run: `grep "^BRIDGE_BACKEND=" .env.example`
Expected: current value is `codex` (fails desired state).

**Step 2: Apply minimal env change**

Set:

```dotenv
BRIDGE_BACKEND=claude
```

Keep all Codex variables in place; do not remove legacy support.

**Step 3: Add coexistence guidance comments**

Add inline comments near `DATA_DIR` and `FEISHU_ACCOUNT_ID` clarifying separate values per bot process.

Example:

```dotenv
# Use a dedicated account/data dir per bot process to avoid lock/session collisions.
FEISHU_ACCOUNT_ID=custom-1
DATA_DIR=/root/projects/wechat-codex-bridge/data/default
```

**Step 4: Validate formatting**

Run: `node --check src/config.js`
Expected: PASS (config parser unaffected by comment additions).

**Step 5: Commit**

```bash
git add .env.example
git commit -m "docs: switch env template default to claude"
```

---

### Task 4: Refresh README for public Claude-first + dual-backend compatibility

**Files:**
- Modify: `README.md`

**Step 1: Update key positioning text**

Ensure opening sections describe backend as:
- Claude-first default
- Codex still supported via `BRIDGE_BACKEND=codex`

**Step 2: Update Quick Start defaults**

- Keep `node src/launcher.js .env.feishu-direct`
- Make example backend default Claude
- Add explicit Codex override example.

Suggested snippet:

```dotenv
# default
BRIDGE_BACKEND=claude

# codex compatibility mode
# BRIDGE_BACKEND=codex
```

**Step 3: Add "Run Claude and Codex side-by-side" section**

Include exact checklist:
- separate bot app credentials
- separate env files
- separate `DATA_DIR`
- separate `FEISHU_ACCOUNT_ID`
- separate processes

**Step 4: Add security note for public repo usage**

Reinforce: never commit real app secrets; only placeholders in `.env.example`.

**Step 5: Commit**

```bash
git add README.md
git commit -m "docs: make claude-first setup and coexistence explicit"
```

---

### Task 5: Verify end-to-end behavior before publishing

**Files:**
- Verify only (no code required)

**Step 1: Run full local verification**

Run: `npm run test && npm run check`
Expected: all PASS.

**Step 2: Start Claude profile locally**

Run: `node src/launcher.js .env.feishu-direct`
Expected logs include backend selection (`claude`) and Feishu websocket ready.

**Step 3: Manual message roundtrip test**

- Send a text message from Feishu to Claude bot.
- Confirm single reply is returned (no duplicate responses).

Expected: inbound -> `runClaudeReply` -> outbound success path works.

**Step 4: Optional Codex regression smoke test**

Run Codex profile with its own env and send one message.
Expected: unchanged Codex behavior.

**Step 5: Commit verification-only adjustments (if any)**

```bash
git add <only-if-files-changed>
git commit -m "chore: finalize compatibility verification"
```

---

### Task 6: Prepare publishable branch and PR

**Files:**
- Verify only

**Step 1: Check working tree**

Run: `git status`
Expected: clean or only intended files staged.

**Step 2: Sanity-check secrets**

Run: `git diff --cached`
Expected: no real `FEISHU_APP_SECRET`/real credentials present.

**Step 3: Push branch**

Run: `git push -u origin <feature-branch>`
Expected: remote branch created.

**Step 4: Open PR with compatibility framing**

Include summary bullets:
- Claude default backend
- Codex compatibility preserved
- dual-bot coexistence docs + tests

**Step 5: Final validation after CI**

Confirm checks pass before merge.

---

## Notes for execution discipline
- Keep changes DRY and minimal; no new abstraction layers.
- Do not alter runtime routing semantics beyond default backend value.
- Prefer small commits per task.
- If any test or check fails, fix root cause before moving to next task.
