import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildBridgePrompt, extractMediaMarkers } from './runner-utils.js';

export function buildSpawnOptions(bin, options = {}, platform = process.platform) {
  const useShell = platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  return {
    cwd: options.cwd,
    shell: useShell,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

function buildExitError(bin, code, stderr, stdout) {
  const commandName = path.basename(bin, path.extname(bin)) || bin || 'process';
  const err = new Error(`${commandName} exited with code ${code}\n${stderr || stdout}`);
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

async function execFileWithStdin(bin, args, options, stdinData) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      ...buildSpawnOptions(bin, options),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options?.timeoutMs ?? options?.timeout ?? 0;
    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      handler(value);
    };

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(reject, error));
    child.on('close', code => {
      if (settled) {
        return;
      }
      if (code === 0) {
        finish(resolve, { stdout, stderr });
      } else {
        finish(reject, buildExitError(bin, code, stderr, stdout));
      }
    });

    let timeoutHandle;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        stopChildProcess(child);
        const err = new Error(`${path.basename(bin) || bin || 'process'} timed out after ${timeoutMs}ms`);
        err.stdout = stdout;
        err.stderr = stderr;
        finish(reject, err);
      }, timeoutMs);
    }

    if (stdinData) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

async function execFileAsync(bin, args, options) {
  return execFileWithStdin(bin, args, options, null);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopChildProcess(child) {
  if (child?.killed || typeof child?.kill !== 'function') {
    return;
  }
  try {
    child.kill();
  } catch {
    // Ignore cleanup failures when salvaging a completed reply.
  }
}

export async function waitForCodexOutput(child, lastMessageFile, options = {}) {
  const pollMs = options.pollMs ?? 250;
  const stableMs = options.stableMs ?? 1500;
  const timeoutMs = options.timeoutMs ?? 300000;
  const deadline = Date.now() + timeoutMs;
  let lastContent = '';
  let lastChangedAt = 0;

  while (Date.now() <= deadline) {
    let content = '';
    try {
      content = (await fs.readFile(lastMessageFile, 'utf8')).trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    if (content) {
      if (content !== lastContent) {
        lastContent = content;
        lastChangedAt = Date.now();
      } else if (Date.now() - lastChangedAt >= stableMs) {
        if (child) {
          child.__codexOutputReady = true;
        }
        stopChildProcess(child);
        return content;
      }
    }

    await delay(pollMs);
  }

  stopChildProcess(child);
  throw new Error(`Codex did not produce a stable reply within ${timeoutMs}ms`);
}

export async function runCodexCommand(bin, args, options = {}, stdinData) {
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs ?? options.timeout ?? 300000;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, {
      ...buildSpawnOptions(bin, options),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutHandle;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      handler(value);
    };

    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on?.('error', error => finish(reject, error));
    child.on?.('close', code => {
      if (settled) {
        return;
      }
      if (child.__codexOutputReady) {
        return;
      }
      if (code === 0) {
        finish(resolve, {
          stdout,
          stderr,
          output: '',
          terminatedAfterOutput: false,
        });
      } else {
        finish(reject, buildExitError(bin, code, stderr, stdout));
      }
    });

    if (stdinData) {
      child.stdin?.write?.(stdinData);
    }
    child.stdin?.end?.();

    if (options.lastMessageFile) {
      waitForCodexOutput(child, options.lastMessageFile, {
        pollMs: options.outputPollMs,
        stableMs: options.outputStableMs,
        timeoutMs,
      })
        .then(output => finish(resolve, {
          stdout,
          stderr,
          output,
          terminatedAfterOutput: true,
        }))
        .catch(error => {
          error.stdout = stdout;
          error.stderr = stderr;
          finish(reject, error);
        });
      return;
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        stopChildProcess(child);
        const err = new Error(`${path.basename(bin) || bin || 'process'} timed out after ${timeoutMs}ms`);
        err.stdout = stdout;
        err.stderr = stderr;
        finish(reject, err);
      }, timeoutMs);
    }
  });
}

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

export function buildCodexExecArgs(config, lastMessageFile) {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '-c', `model_reasoning_effort="${config.reasoningEffort}"`,
    '--sandbox', config.sandbox,
    '--model', config.model,
    '--output-last-message', lastMessageFile,
    '-C', config.workdir,
  ];
  for (const dir of config.additionalDirs || []) {
    args.push('--add-dir', dir);
  }
  return args;
}

export function getCodexOutputDir(config) {
  return path.join(config.workdir, '.feishu-codex-bridge');
}

export async function runCodexReply(config, history, inbound) {
  const outputDir = getCodexOutputDir(config);
  await fs.mkdir(outputDir, { recursive: true });
  const lastMessageFile = path.join(outputDir, 'last-message.txt');
  await fs.rm(lastMessageFile, { force: true });

  const prompt = buildBridgePrompt(config.systemPrompt, history, inbound);
  const args = buildCodexExecArgs(config, lastMessageFile);

  const imageAttachments = (inbound.attachments || [])
    .filter(attachment => attachment.kind === 'image')
    .slice(0, config.maxImageAttachments);
  for (const image of imageAttachments) {
    const preparedImage = await ensurePreparedImage(config, image.path, outputDir);
    args.push('--image', preparedImage);
  }

  const result = await runCodexCommand(config.bin, args, {
    cwd: config.workdir,
    lastMessageFile,
    timeoutMs: config.timeoutMs,
  }, prompt);
  const rawReply = result.output || (await fs.readFile(lastMessageFile, 'utf8')).trim();

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
