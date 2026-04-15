import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

test('buildCodexExecArgs formats model_reasoning_effort as a valid TOML string', async () => {
  const { buildCodexExecArgs } = await import('../src/codex-runner.js');
  const args = buildCodexExecArgs({
    reasoningEffort: 'low',
    sandbox: 'workspace-write',
    model: 'gpt-5.4',
    workdir: 'D:/projects',
  }, 'D:/tmp/last-message.txt');

  const configIndex = args.indexOf('-c');
  assert.notEqual(configIndex, -1);
  assert.equal(args[configIndex + 1], 'model_reasoning_effort="low"');
});

test('buildSpawnOptions enables shell for cmd launchers on Windows', async () => {
  const { buildSpawnOptions } = await import('../src/codex-runner.js');
  const options = buildSpawnOptions('codex.cmd', {
    cwd: 'D:/projects',
  }, 'win32');

  assert.equal(options.cwd, 'D:/projects');
  assert.equal(options.shell, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('buildCodexExecArgs appends add-dir flags for codex additional dirs', async () => {
  const { buildCodexExecArgs } = await import('../src/codex-runner.js');
  const args = buildCodexExecArgs({
    reasoningEffort: 'low',
    sandbox: 'danger-full-access',
    model: 'gpt-5.4',
    workdir: 'D:/projects',
    additionalDirs: ['D:/tools', 'D:/.playwright-cli'],
  }, 'D:/tmp/last-message.txt');

  assert.deepEqual(args.slice(-4), [
    '--add-dir', 'D:/tools',
    '--add-dir', 'D:/.playwright-cli',
  ]);
});

test('waitForCodexOutput resolves from a stable last-message file even if the process does not exit', async () => {
  const { waitForCodexOutput } = await import('../src/codex-runner.js');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-'));
  const lastMessageFile = path.join(tempDir, 'last-message.txt');

  const child = {
    killed: false,
    kill() {
      this.killed = true;
    },
  };

  setTimeout(async () => {
    await fs.writeFile(lastMessageFile, 'ready');
  }, 20);

  const result = await waitForCodexOutput(child, lastMessageFile, {
    pollMs: 10,
    stableMs: 40,
    timeoutMs: 1000,
  });

  assert.equal(result, 'ready');
  assert.equal(child.killed, true);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('runCodexCommand resolves from the reply file and kills a hung child process', async () => {
  const { runCodexCommand } = await import('../src/codex-runner.js');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-cmd-'));
  const lastMessageFile = path.join(tempDir, 'last-message.txt');

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrites = [];
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    write(chunk) {
      stdinWrites.push(chunk);
    },
    end() {
      stdinWrites.push('<ended>');
    },
  };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', 0);
  };

  setTimeout(async () => {
    await fs.writeFile(lastMessageFile, 'stable reply');
  }, 20);

  const result = await runCodexCommand('fake-codex', ['exec'], {
    cwd: tempDir,
    lastMessageFile,
    timeoutMs: 500,
    outputPollMs: 10,
    outputStableMs: 40,
    spawnImpl: () => child,
  }, 'prompt');

  assert.equal(result.output, 'stable reply');
  assert.equal(result.terminatedAfterOutput, true);
  assert.equal(child.killed, true);
  assert.deepEqual(stdinWrites, ['prompt', '<ended>']);

  await fs.rm(tempDir, { recursive: true, force: true });
});
