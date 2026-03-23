import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

function buildPrompt(systemPrompt, history, userMessage) {
  const historyText = history
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.text}`)
    .join('\n\n');

  return [
    systemPrompt,
    '',
    'Conversation so far:',
    historyText || '(empty)',
    '',
    'Current user message:',
    userMessage,
    '',
    'Reply to the current user message directly.',
  ].join('\n');
}

export async function runCodexReply(config, history, userMessage) {
  const outputDir = path.join(config.workdir, '.wechat-codex-bridge');
  await fs.mkdir(outputDir, { recursive: true });
  const lastMessageFile = path.join(outputDir, 'last-message.txt');

  const prompt = buildPrompt(config.systemPrompt, history, userMessage);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', config.sandbox,
    '--model', config.model,
    '--output-last-message', lastMessageFile,
    '-C', config.workdir,
    prompt,
  ];

  await execFileAsync(config.bin, args, {
    cwd: config.workdir,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });

  const reply = (await fs.readFile(lastMessageFile, 'utf8')).trim();
  if (!reply) {
    throw new Error('Codex returned an empty reply');
  }
  return reply;
}
