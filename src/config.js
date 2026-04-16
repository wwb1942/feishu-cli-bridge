import path from 'node:path';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseCsv(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntegerEnv(name, fallback, options = {}) {
  const rawValue = process.env[name];
  const text = typeof rawValue === 'string' && rawValue.trim()
    ? rawValue.trim()
    : String(fallback);
  const value = Number.parseInt(text, 10);

  if (!Number.isInteger(value)) {
    throw new Error(`Invalid ${name}: expected an integer value.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`Invalid ${name}: expected a value >= ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`Invalid ${name}: expected a value <= ${options.max}.`);
  }

  return value;
}

export function loadConfig() {
  const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data'));
  const sessionsDir = path.join(dataDir, 'sessions');
  const mediaDir = path.join(dataDir, 'media');
  const inboundStateFile = path.join(dataDir, 'inbound-state.json');
  const inboundClaimsDir = path.join(dataDir, 'inbound-claims');
  const processLockFile = path.join(dataDir, 'bridge.lock');
  const defaultCodexBin = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const defaultClaudeBin = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const backend = (process.env.BRIDGE_BACKEND || 'claude').trim().toLowerCase();
  if (!['codex', 'claude'].includes(backend)) {
    throw new Error(`Unsupported BRIDGE_BACKEND: ${backend}`);
  }

  const claudeWorkdir = path.resolve(process.env.CLAUDE_WORKDIR || projectRoot);
  const codexWorkdir = path.resolve(process.env.CODEX_WORKDIR || projectRoot);
  const codexAdditionalDirs = [
    codexWorkdir,
    ...parseCsv(process.env.CODEX_ADD_DIRS || '').map((item) => path.resolve(item)),
  ].filter((item, index, list) => list.indexOf(item) === index);
  const claudeAdditionalDirs = [
    claudeWorkdir,
    ...parseCsv(process.env.CLAUDE_ADD_DIRS || '').map((item) => path.resolve(item)),
  ].filter((item, index, list) => list.indexOf(item) === index);

  return {
    backend,
    projectRoot,
    dataDir,
    sessionsDir,
    mediaDir,
    inboundStateFile,
    inboundClaimsDir,
    processLockFile,
    codex: {
      bin: process.env.CODEX_BIN || defaultCodexBin,
      model: process.env.CODEX_MODEL || 'gpt-5.4',
      reasoningEffort: process.env.CODEX_REASONING_EFFORT || 'low',
      sandbox: process.env.CODEX_SANDBOX || 'workspace-write',
      workdir: codexWorkdir,
      additionalDirs: codexAdditionalDirs,
      historyLimit: parseIntegerEnv('CODEX_HISTORY_LIMIT', 12, { min: 1 }),
      imageHistoryLimit: parseIntegerEnv('CODEX_IMAGE_HISTORY_LIMIT', 4, { min: 1 }),
      maxImageAttachments: parseIntegerEnv('CODEX_MAX_IMAGE_ATTACHMENTS', 4, { min: 1 }),
      timeoutMs: parseIntegerEnv('CODEX_TIMEOUT_MS', 180000, { min: 1000 }),
      maxImageDimension: parseIntegerEnv('CODEX_MAX_IMAGE_DIMENSION', 1280, { min: 64 }),
      systemPrompt: process.env.CODEX_BRIDGE_SYSTEM_PROMPT || 'You are Codex in a Feishu bot bridge. Reply concisely and helpfully in plain text. If you want to return media, emit one marker per line: [[image:/absolute/path]] or [[file:/absolute/path]]. Keep any user-visible text outside those markers.',
    },
    claude: {
      bin: process.env.CLAUDE_BIN || defaultClaudeBin,
      model: process.env.CLAUDE_MODEL || '',
      planModel: process.env.CLAUDE_PLAN_MODEL || 'claude-opus-4-6',
      effort: process.env.CLAUDE_EFFORT || '',
      workdir: claudeWorkdir,
      historyLimit: parseIntegerEnv('CLAUDE_HISTORY_LIMIT', 12, { min: 1 }),
      imageHistoryLimit: parseIntegerEnv('CLAUDE_IMAGE_HISTORY_LIMIT', 4, { min: 1 }),
      timeoutMs: parseIntegerEnv('CLAUDE_TIMEOUT_MS', 240000, { min: 1000 }),
      allowedTools: parseCsv(process.env.CLAUDE_ALLOWED_TOOLS || 'Read,Glob,Grep,Bash'),
      additionalDirs: claudeAdditionalDirs,
      systemPrompt: process.env.CLAUDE_BRIDGE_SYSTEM_PROMPT || 'You are Claude in a Feishu bot bridge running on the user machine. Reply concisely and helpfully in plain text. Reply with final user-facing text only. Do not mention skills, workflow, or internal process. If you want to return media, emit one marker per line: [[image:/absolute/path]] or [[file:/absolute/path]].',
    },
    feishu: {
      appId: requireEnv('FEISHU_APP_ID'),
      appSecret: requireEnv('FEISHU_APP_SECRET'),
      domain: process.env.FEISHU_DOMAIN || 'feishu',
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
      groupDelegationEnabled: /^true$/i.test(process.env.FEISHU_GROUP_DELEGATION_ENABLED || ''),
      botOpenId: process.env.FEISHU_BOT_OPEN_ID || '',
      delegateTimeoutMs: parseIntegerEnv('FEISHU_DELEGATE_TIMEOUT_MS', 300000, { min: 1000 }),
      discussionHostBotOpenId: process.env.FEISHU_DISCUSSION_HOST_BOT_OPEN_ID || '',
      discussionMaxBotMessages: parseIntegerEnv('FEISHU_DISCUSSION_MAX_BOT_MESSAGES', 20, { min: 1 }),
      discussionMaxDurationMs: parseIntegerEnv('FEISHU_DISCUSSION_MAX_DURATION_MS', 900000, { min: 1000 }),
      chunkChars: parseIntegerEnv('FEISHU_REPLY_CHUNK_CHARS', 1400, { min: 1 }),
      accountId: process.env.FEISHU_ACCOUNT_ID || 'custom-1',
      maxInboundBytes: parseIntegerEnv('FEISHU_MAX_INBOUND_BYTES', 30 * 1024 * 1024, { min: 1 }),
      inboundDedupWindowMs: parseIntegerEnv('FEISHU_INBOUND_DEDUP_WINDOW_MS', 12000, { min: 1 }),
      inboundProcessingTtlMs: parseIntegerEnv('FEISHU_INBOUND_PROCESSING_TTL_MS', 300000, { min: 1 }),
      inboundRepliedTtlMs: parseIntegerEnv('FEISHU_INBOUND_REPLIED_TTL_MS', 86400000, { min: 1 }),
    },
  };
}
