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
