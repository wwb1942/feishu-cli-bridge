import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildBridgePrompt, extractMediaMarkers } from './runner-utils.js';

const execFileAsync = promisify(execFile);

async function ensurePreparedImage(config, imagePath, outputDir) {
  const preparedPath = path.join(outputDir, `prepared-${path.basename(imagePath, path.extname(imagePath))}.jpg`);
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', imagePath,
    '-vf', `scale='min(${config.maxImageDimension},iw)':'min(${config.maxImageDimension},ih)':force_original_aspect_ratio=decrease`,
    '-q:v', '3',
    preparedPath,
  ], {
    cwd: config.workdir,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
  });
  return preparedPath;
}

export async function runCodexReply(config, history, inbound) {
  const outputDir = path.join(config.workdir, '.wechat-codex-bridge');
  await fs.mkdir(outputDir, { recursive: true });
  const lastMessageFile = path.join(outputDir, 'last-message.txt');

  const prompt = buildBridgePrompt(config.systemPrompt, history, inbound);
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
    const preparedImage = await ensurePreparedImage(config, image.path, outputDir);
    args.push('--image', preparedImage);
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
