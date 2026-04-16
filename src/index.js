import { loadConfig } from './config.js';
import { runCodexReply } from './codex-runner.js';
import { runClaudeReply } from './claude-runner.js';
import { startBridgeApp } from './bridge-app.js';

const config = loadConfig();
const backendConfig = config.backend === 'claude' ? config.claude : config.codex;
const runReply = config.backend === 'claude' ? runClaudeReply : runCodexReply;

const app = await startBridgeApp({
  config,
  backendConfig,
  runReply,
});

console.log('[bridge] feishu-cli-bridge started');
console.log(`[bridge] backend: ${config.backend}`);
console.log(`[bridge] backend model: ${backendConfig.model || '<cli-default>'}`);
console.log(`[bridge] sessions dir: ${config.sessionsDir}`);
console.log(`[bridge] media dir: ${config.mediaDir}`);
console.log(`[bridge] process pid: ${process.pid}`);

const shutdown = async () => {
  await app.shutdown().catch(() => {});
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
