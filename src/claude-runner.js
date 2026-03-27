import { spawn } from 'node:child_process';
import { buildBridgePrompt, extractMediaMarkers } from './runner-utils.js';

const TMUX_READY_RE = /^Tmux ready\. Use 'tmux attach -t .+' to connect\.$/;

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
      setTimeout(() => {
        if (!finished) {
          child.kill('SIGKILL');
        }
      }, 2000);
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
  const prompt = buildBridgePrompt(config.systemPrompt, history, inbound);
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--system-prompt', config.systemPrompt,
  ];

  if (config.model) {
    args.push('--model', config.model);
  }
  if (config.effort) {
    args.push('--effort', config.effort);
  }
  if (config.allowedTools.length > 0) {
    args.push('--allowedTools', config.allowedTools.join(','));
  } else {
    args.push('--allowedTools', '');
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
