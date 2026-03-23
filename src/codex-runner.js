import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const MEDIA_MARKER_RE = /^\[\[(image|file):(.+?)\]\]$/i;

function buildHistoryText(history) {
  return history
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.text}`)
    .join('\n\n');
}

function buildAttachmentSummary(attachments) {
  if (!attachments?.length) {
    return '(none)';
  }
  return attachments
    .map((attachment, index) => {
      return `${index + 1}. type=${attachment.kind} path=${attachment.path}${attachment.fileName ? ` fileName=${attachment.fileName}` : ''}`;
    })
    .join('\n');
}

function buildPrompt(systemPrompt, history, inbound) {
  const historyText = buildHistoryText(history);
  return [
    systemPrompt,
    '',
    'Conversation so far:',
    historyText || '(empty)',
    '',
    'Current user message:',
    inbound.text,
    '',
    'Inbound attachments saved locally:',
    buildAttachmentSummary(inbound.attachments),
    '',
    'If images are attached through the CLI, inspect them directly. For non-image files, you may read the provided local paths if useful.',
    'If you want to send media back, output markers like [[image:/absolute/path]] or [[file:/absolute/path]].',
    'Reply to the current user message directly.',
  ].join('\n');
}

function extractMediaMarkers(rawReply) {
  const textLines = [];
  const media = [];

  for (const line of rawReply.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(MEDIA_MARKER_RE);
    if (!match) {
      textLines.push(line);
      continue;
    }
    media.push({
      kind: match[1].toLowerCase(),
      path: match[2].trim(),
    });
  }

  return {
    text: textLines.join('\n').trim(),
    media,
  };
}

export async function runCodexReply(config, history, inbound) {
  const outputDir = path.join(config.workdir, '.wechat-codex-bridge');
  await fs.mkdir(outputDir, { recursive: true });
  const lastMessageFile = path.join(outputDir, 'last-message.txt');

  const prompt = buildPrompt(config.systemPrompt, history, inbound);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '-c', `model_reasoning_effort=\"${config.reasoningEffort}\"`,
    '--sandbox', config.sandbox,
    '--model', config.model,
    '--output-last-message', lastMessageFile,
    '-C', config.workdir,
  ];

  const imageAttachments = (inbound.attachments || [])
    .filter((attachment) => attachment.kind === 'image')
    .slice(0, config.maxImageAttachments);
  for (const image of imageAttachments) {
    args.push('--image', image.path);
  }

  args.push(prompt);

  await execFileAsync(config.bin, args, {
    cwd: config.workdir,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: config.timeoutMs,
  });

  const rawReply = (await fs.readFile(lastMessageFile, 'utf8')).trim();
  if (!rawReply) {
    throw new Error('Codex returned an empty reply');
  }

  const parsed = extractMediaMarkers(rawReply);
  return {
    text: parsed.text,
    media: parsed.media,
    raw: rawReply,
  };
}
