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
  const config = withEnv(
    {
      FEISHU_APP_ID: 'test-app-id',
      FEISHU_APP_SECRET: 'test-app-secret',
      BRIDGE_BACKEND: '',
    },
    () => loadConfig(),
  );

  assert.equal(config.backend, 'claude');
});

test('keeps codex backend when explicitly configured', async () => {
  const { loadConfig } = await import('../src/config.js');
  const config = withEnv(
    {
      FEISHU_APP_ID: 'test-app-id',
      FEISHU_APP_SECRET: 'test-app-secret',
      BRIDGE_BACKEND: 'codex',
    },
    () => loadConfig(),
  );

  assert.equal(config.backend, 'codex');
});

test('parses CODEX_ADD_DIRS into unique absolute codex additional dirs', async () => {
  const { loadConfig } = await import('../src/config.js');
  const config = withEnv(
    {
      FEISHU_APP_ID: 'test-app-id',
      FEISHU_APP_SECRET: 'test-app-secret',
      BRIDGE_BACKEND: 'codex',
      PROJECT_ROOT: 'D:/projects/feishu-cli-bridge',
      CODEX_WORKDIR: 'D:/projects',
      CODEX_ADD_DIRS: 'D:/tools,D:/browser-profiles,D:/tools',
    },
    () => loadConfig(),
  );

  assert.deepEqual(config.codex.additionalDirs, [
    'D:\\projects',
    'D:\\tools',
    'D:\\browser-profiles',
  ]);
});

test('reads group delegation and discussion config keys', async () => {
  const { loadConfig } = await import('../src/config.js');
  const config = withEnv(
    {
      FEISHU_APP_ID: 'test-app-id',
      FEISHU_APP_SECRET: 'test-app-secret',
      FEISHU_GROUP_DELEGATION_ENABLED: 'true',
      FEISHU_BOT_OPEN_ID: 'ou_bot_self',
      FEISHU_DELEGATE_TIMEOUT_MS: '12345',
      FEISHU_DISCUSSION_HOST_BOT_OPEN_ID: 'ou_bot_host',
      FEISHU_DISCUSSION_MAX_BOT_MESSAGES: '42',
      FEISHU_DISCUSSION_MAX_DURATION_MS: '67890',
    },
    () => loadConfig(),
  );

  assert.equal(config.feishu.groupDelegationEnabled, true);
  assert.equal(config.feishu.botOpenId, 'ou_bot_self');
  assert.equal(config.feishu.delegateTimeoutMs, 12345);
  assert.equal(config.feishu.discussionHostBotOpenId, 'ou_bot_host');
  assert.equal(config.feishu.discussionMaxBotMessages, 42);
  assert.equal(config.feishu.discussionMaxDurationMs, 67890);
});

test('rejects invalid numeric config values with descriptive errors', async () => {
  const { loadConfig } = await import('../src/config.js');

  assert.throws(
    () => withEnv(
      {
        FEISHU_APP_ID: 'test-app-id',
        FEISHU_APP_SECRET: 'test-app-secret',
        FEISHU_DELEGATE_TIMEOUT_MS: '-1',
      },
      () => loadConfig(),
    ),
    /FEISHU_DELEGATE_TIMEOUT_MS/i,
  );

  assert.throws(
    () => withEnv(
      {
        FEISHU_APP_ID: 'test-app-id',
        FEISHU_APP_SECRET: 'test-app-secret',
        CODEX_TIMEOUT_MS: 'not-a-number',
      },
      () => loadConfig(),
    ),
    /CODEX_TIMEOUT_MS/i,
  );
});
