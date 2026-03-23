import { loadConfig } from './config.js';
import { ensureSessionStore, loadConversation, saveConversation, appendConversation } from './session-store.js';
import { runCodexReply } from './codex-runner.js';
import { startFeishuBridge } from './feishu-adapter.js';
import fs from 'node:fs/promises';

const config = loadConfig();
await ensureSessionStore(config.sessionsDir);
await fs.mkdir(config.mediaDir, { recursive: true });

const queues = new Map();
const pendingMedia = new Map();
const recentInbound = new Map();
const MEDIA_PLACEHOLDER_RE = /^\[(image|file|audio|media|message)\]$/i;
const INBOUND_DEDUP_WINDOW_MS = 12_000;

function enqueue(peerId, task) {
  const previous = queues.get(peerId) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(peerId, next.catch(() => {}));
  return next;
}

function isPlaceholderOnlyMessage(text) {
  return MEDIA_PLACEHOLDER_RE.test((text || '').trim());
}

function queuePendingMedia(peerId, inbound) {
  const current = pendingMedia.get(peerId) || [];
  pendingMedia.set(peerId, [...current, ...(inbound.attachments || [])]);
}

function consumePendingMedia(peerId) {
  const attachments = pendingMedia.get(peerId) || [];
  pendingMedia.delete(peerId);
  return attachments;
}

function summarizeAttachments(attachments) {
  if (!attachments?.length) {
    return '';
  }
  return attachments.map((attachment) => `[${attachment.kind}] ${attachment.path}`).join('\n');
}

function isDuplicateInbound(inbound) {
  const messageId = inbound.meta?.messageId?.trim();
  if (messageId) {
    if (recentInbound.has(messageId)) {
      return true;
    }
    recentInbound.set(messageId, Date.now());
    return false;
  }

  const fingerprint = `${inbound.peerId}:${inbound.text}:${(inbound.attachments || []).map((item) => item.path).join('|')}`;
  const lastSeenAt = recentInbound.get(fingerprint);
  recentInbound.set(fingerprint, Date.now());
  return Boolean(lastSeenAt && Date.now() - lastSeenAt < INBOUND_DEDUP_WINDOW_MS);
}

function pruneRecentInbound() {
  const now = Date.now();
  for (const [key, timestamp] of recentInbound.entries()) {
    if (now - timestamp > INBOUND_DEDUP_WINDOW_MS) {
      recentInbound.delete(key);
    }
  }
}

const bridge = await startFeishuBridge(config.feishu, config.mediaDir, async (inbound) => {
  pruneRecentInbound();
  if (isDuplicateInbound(inbound)) {
    console.log(`[bridge] duplicate inbound skipped for ${inbound.peerId}`);
    return;
  }

  console.log(`[bridge] inbound from ${inbound.peerId}: ${inbound.text}`);

  if ((inbound.attachments?.length || 0) > 0 && isPlaceholderOnlyMessage(inbound.text)) {
    queuePendingMedia(inbound.peerId, inbound);
    console.log(`[bridge] queued media placeholder for ${inbound.peerId}`);
    return;
  }

  await enqueue(inbound.peerId, async () => {
    const mergedAttachments = [
      ...consumePendingMedia(inbound.peerId),
      ...(inbound.attachments || []),
    ];
    const effectiveInbound = {
      ...inbound,
      attachments: mergedAttachments,
    };

    const history = await loadConversation(config.sessionsDir, inbound.peerId);
    const historyLimit = effectiveInbound.attachments?.length
      ? Math.min(config.codex.historyLimit, config.codex.imageHistoryLimit)
      : config.codex.historyLimit;
    const trimmedHistory = history.slice(-historyLimit);

    let reply;
    try {
      reply = await runCodexReply(config.codex, trimmedHistory, effectiveInbound);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] codex failed for ${inbound.peerId}: ${message}`);
      const fallbackReply = {
        text: `抱歉，我刚刚处理这条消息超时或失败了。请你再发一次，或者把问题说得更短一点。错误: ${message}`,
        media: [],
        raw: '',
      };
      await bridge.sendReply(inbound.meta.senderOpenId || inbound.peerId, fallbackReply, {
        messageId: inbound.meta.messageId,
      });
      return;
    }

    const userText = [effectiveInbound.text, summarizeAttachments(effectiveInbound.attachments)].filter(Boolean).join('\n');
    const updated = appendConversation(trimmedHistory, { role: 'user', text: userText, timestamp: Date.now() }, config.codex.historyLimit * 2);
    const assistantText = [reply.text, ...(reply.media || []).map((item) => `[[${item.kind}:${item.path}]]`)].filter(Boolean).join('\n');
    const finalHistory = appendConversation(updated, { role: 'assistant', text: assistantText, timestamp: Date.now() }, config.codex.historyLimit * 2);
    await saveConversation(config.sessionsDir, inbound.peerId, finalHistory);

    await bridge.sendReply(inbound.meta.senderOpenId || inbound.peerId, reply, {
      messageId: inbound.meta.messageId,
    });
    console.log(`[bridge] replied to ${inbound.peerId}`);
  });
});

console.log('[bridge] feishu-codex-bridge started');
console.log(`[bridge] codex model: ${config.codex.model}`);
console.log(`[bridge] sessions dir: ${config.sessionsDir}`);
console.log(`[bridge] media dir: ${config.mediaDir}`);
