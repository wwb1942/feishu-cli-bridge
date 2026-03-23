import path from 'node:path';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig() {
  const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data'));
  const sessionsDir = path.join(dataDir, 'sessions');
  const mediaDir = path.join(dataDir, 'media');

  return {
    projectRoot,
    dataDir,
    sessionsDir,
    mediaDir,
    codex: {
      bin: process.env.CODEX_BIN || 'codex',
      model: process.env.CODEX_MODEL || 'gpt-5.4',
      sandbox: process.env.CODEX_SANDBOX || 'workspace-write',
      workdir: path.resolve(process.env.CODEX_WORKDIR || projectRoot),
      historyLimit: Number.parseInt(process.env.CODEX_HISTORY_LIMIT || '12', 10),
      maxImageAttachments: Number.parseInt(process.env.CODEX_MAX_IMAGE_ATTACHMENTS || '4', 10),
      systemPrompt: process.env.CODEX_BRIDGE_SYSTEM_PROMPT || 'You are Codex in a Feishu bot bridge. Reply concisely and helpfully in plain text. If you want to return media, emit one marker per line: [[image:/absolute/path]] or [[file:/absolute/path]]. Keep any user-visible text outside those markers.',
    },
    feishu: {
      appId: requireEnv('FEISHU_APP_ID'),
      appSecret: requireEnv('FEISHU_APP_SECRET'),
      domain: process.env.FEISHU_DOMAIN || 'feishu',
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
      chunkChars: Number.parseInt(process.env.FEISHU_REPLY_CHUNK_CHARS || '1400', 10),
      accountId: process.env.FEISHU_ACCOUNT_ID || 'custom-1',
      maxInboundBytes: Number.parseInt(process.env.FEISHU_MAX_INBOUND_BYTES || String(30 * 1024 * 1024), 10),
    },
  };
}
