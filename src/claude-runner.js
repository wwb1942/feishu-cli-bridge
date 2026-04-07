import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildBridgePrompt, extractMediaMarkers } from './runner-utils.js';

const execFileAsync = promisify(execFile);

async function normalizeImage(imagePath, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `normalized-${path.basename(imagePath, path.extname(imagePath))}.png`);
  await execFileAsync('ffmpeg', [
    '-y', '-i', imagePath,
    '-pix_fmt', 'rgb24',
    outPath,
  ], { timeout: 30000 });
  return outPath;
}

async function prepareAttachments(attachments, outputDir) {
  const result = [];
  for (const att of attachments) {
    if (att.kind === 'image') {
      try {
        const normalized = await normalizeImage(att.path, outputDir);
        result.push({ ...att, path: normalized });
      } catch {
        result.push(att);
      }
    } else {
      result.push(att);
    }
  }
  return result;
}

const TMUX_READY_RE = /^Tmux ready\. Use 'tmux attach -t .+' to connect\.$/;
const PLANNING_RE = /规划|设计|分析|方案|架构|评估|调研|plan|design|analyze|architect|review|assess/i;

function stripKnownPreamble(rawOutput) {
  const lines = rawOutput.split(/\r?\n/);
  while (lines.length > 0) {
    const trimmed = lines[0].trim();
    if (!trimmed || TMUX_READY_RE.test(trimmed)) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join('\n').trim();
}

function parseClaudeJson(stdout) {
  const cleaned = stripKnownPreamble(stdout);
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (!candidate.startsWith('{')) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep walking upward until we find a valid JSON payload.
    }
  }
  return null;
}

async function runClaudeProcess(bin, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > options.maxBuffer) {
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > options.maxBuffer) {
        child.kill('SIGTERM');
      }
    });

    child.on('error', (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Claude exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    child.stdin.end();
  });
}

export async function runClaudeReply(config, history, inbound) {
  const outputDir = path.join(config.workdir, '.feishu-claude-bridge');
  const preparedAttachments = await prepareAttachments(inbound.attachments || [], outputDir);
  const effectiveInbound = { ...inbound, attachments: preparedAttachments };
  const prompt = buildBridgePrompt(config.systemPrompt, history, effectiveInbound);
  const effectiveModel = PLANNING_RE.test(inbound.text) ? config.planModel : (config.model || 'claude-sonnet-4-6');
  console.log(`[bridge] model selected: ${effectiveModel} for: "${inbound.text.slice(0, 40)}"`);
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--system-prompt', config.systemPrompt,
  ];

  args.push('--model', effectiveModel);
  if (config.effort) {
    args.push('--effort', config.effort);
  }
  if (config.allowedTools.length > 0) {
    args.push('--allowedTools', config.allowedTools.join(','));
  } else {
    args.push('--tools', '');
  }
  for (const dir of config.additionalDirs) {
    args.push('--add-dir', dir);
  }

  args.push('--', prompt);

  const { stdout, stderr } = await runClaudeProcess(config.bin, args, {
    cwd: config.workdir,
    timeoutMs: config.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });

  const payload = parseClaudeJson(stdout);
  if (payload?.is_error) {
    const message = typeof payload.result === 'string' && payload.result.trim()
      ? payload.result.trim()
      : stripKnownPreamble(stderr || stdout) || 'Claude returned an error';
    throw new Error(message);
  }

  const rawReply = typeof payload?.result === 'string'
    ? payload.result.trim()
    : stripKnownPreamble(stdout);
  if (!rawReply) {
    const detail = stripKnownPreamble(stderr || stdout);
    throw new Error(detail || 'Claude returned an empty reply');
  }

  const parsed = extractMediaMarkers(rawReply);
  return {
    text: parsed.text,
    media: parsed.media,
    raw: rawReply,
  };
}
