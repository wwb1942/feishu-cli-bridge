import { loadConfig } from './config.js';
import {
  acquireProcessLock,
  ensureSessionStore,
  loadConversation,
  saveConversation,
  appendConversation,
  loadInboundState,
  saveInboundState,
  claimInboundEvent,
  updateInboundEventClaim,
  releaseInboundEventClaim,
} from './session-store.js';
import { runCodexReply } from './codex-runner.js';
import { runClaudeReply } from './claude-runner.js';
import { startFeishuBridge } from './feishu-adapter.js';
import fs from 'node:fs/promises';

const config = loadConfig();
const backendConfig = config.backend === 'claude' ? config.claude : config.codex;
const runReply = config.backend === 'claude' ? runClaudeReply : runCodexReply;
await ensureSessionStore(config.sessionsDir);
await fs.mkdir(config.mediaDir, { recursive: true });
const releaseProcessLock = await acquireProcessLock(config.processLockFile);
const inboundState = await loadInboundState(config.inboundStateFile);

const queues = new Map();
const pendingMedia = new Map();
const recentMedia = new Map();
const recentInbound = new Map();
const MEDIA_PLACEHOLDER_RE = /^\[(image|file|audio|media|message)\]$/i;
const MEDIA_MERGE_WAIT_MS = 1200;
const MEDIA_MERGE_POLL_MS = 150;
const RECENT_MEDIA_TTL_MS = 10 * 60 * 1000;
const IMAGE_REFERENCE_RE = /(这张|图片|图里|截图|这幅|这图|photo|image|picture|attachment|附件)/i;

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
  rememberRecentMedia(peerId, inbound.attachments || []);
}

function consumePendingMedia(peerId) {
  const attachments = pendingMedia.get(peerId) || [];
  pendingMedia.delete(peerId);
  return attachments;
}

function rememberRecentMedia(peerId, attachments) {
  if (!attachments?.length) {
    return;
  }
  const current = recentMedia.get(peerId) || [];
  const next = [...current, ...attachments.map((attachment) => ({
    ...attachment,
    rememberedAt: Date.now(),
  }))].slice(-8);
  recentMedia.set(peerId, next);
}

function pruneRecentMedia(now = Date.now()) {
  for (const [peerId, entries] of recentMedia.entries()) {
    const filtered = entries.filter((entry) => now - (entry.rememberedAt || 0) <= RECENT_MEDIA_TTL_MS);
    if (filtered.length === 0) {
      recentMedia.delete(peerId);
      continue;
    }
    recentMedia.set(peerId, filtered);
  }
}

function shouldUseRecentMedia(text) {
  return IMAGE_REFERENCE_RE.test((text || '').trim());
}

function getRecentMediaForPeer(peerId) {
  const entries = recentMedia.get(peerId) || [];
  return entries.length > 0 ? [entries[entries.length - 1]] : [];
}

async function waitForPendingMedia(peerId) {
  const deadline = Date.now() + MEDIA_MERGE_WAIT_MS;
  while (Date.now() < deadline) {
    const attachments = pendingMedia.get(peerId);
    if (attachments && attachments.length > 0) {
      return consumePendingMedia(peerId);
    }
    await new Promise((resolve) => setTimeout(resolve, MEDIA_MERGE_POLL_MS));
  }
  return consumePendingMedia(peerId);
}

function summarizeAttachments(attachments) {
  if (!attachments?.length) {
    return '';
  }
  return attachments.map((attachment) => `[${attachment.kind}] ${attachment.path}`).join('\n');
}

function buildInboundContentFingerprint(inbound) {
  const attachmentSummary = (inbound.attachments || [])
    .map((item) => `${item.kind}:${item.fileName || item.path || ''}`)
    .join('|');
  const contentFingerprint = inbound.meta?.contentFingerprint?.trim();
  if (contentFingerprint) {
    return contentFingerprint;
  }
  return `${inbound.peerId}:${inbound.text}:${attachmentSummary}`;
}

function getInboundEventKeys(inbound) {
  const keys = [];
  const eventId = inbound.meta?.eventId?.trim();
  if (eventId) {
    keys.push(`event:${eventId}`);
  }
  const messageId = inbound.meta?.messageId?.trim();
  if (messageId) {
    keys.push(`message:${messageId}`);
  }
  return [...new Set(keys)];
}

function pruneRecentInbound(now = Date.now()) {
  for (const [key, timestamp] of recentInbound.entries()) {
    if (now - timestamp > config.feishu.inboundDedupWindowMs) {
      recentInbound.delete(key);
    }
  }
}

function pruneInboundState(now = Date.now()) {
  for (const [key, entry] of Object.entries(inboundState.events || {})) {
    if (!entry || typeof entry !== 'object') {
      delete inboundState.events[key];
      continue;
    }
    const updatedAt = Number(entry.updatedAt) || 0;
    const ttl = entry.status === 'replied'
      ? config.feishu.inboundRepliedTtlMs
      : config.feishu.inboundProcessingTtlMs;
    if (now - updatedAt > ttl) {
      delete inboundState.events[key];
    }
  }
}

async function persistInboundState() {
  await saveInboundState(config.inboundStateFile, inboundState);
}

async function claimInbound(inbound) {
  const now = Date.now();
  const eventKeys = getInboundEventKeys(inbound);

  for (const eventKey of eventKeys) {
    const recentSeenAt = recentInbound.get(eventKey);
    if (recentSeenAt && now - recentSeenAt < config.feishu.inboundDedupWindowMs) {
      return { accepted: false, eventKey, eventKeys, reason: 'memory-window' };
    }
  }

  for (const eventKey of eventKeys) {
    const existing = inboundState.events[eventKey];
    if (existing?.status === 'replied' && now - (Number(existing.updatedAt) || 0) < config.feishu.inboundRepliedTtlMs) {
      recentInbound.set(eventKey, now);
      return { accepted: false, eventKey, eventKeys, reason: 'already-replied' };
    }

    if (existing?.status === 'processing' && now - (Number(existing.updatedAt) || 0) < config.feishu.inboundProcessingTtlMs) {
      recentInbound.set(eventKey, now);
      return { accepted: false, eventKey, eventKeys, reason: 'already-processing' };
    }
  }

  for (const eventKey of eventKeys) {
    recentInbound.set(eventKey, now);
  }

  const claimedEntries = [];
  for (const eventKey of eventKeys) {
    const existing = inboundState.events[eventKey];
    const ttlMs = existing?.status === 'replied'
      ? config.feishu.inboundRepliedTtlMs
      : config.feishu.inboundProcessingTtlMs;
    const fileClaim = await claimInboundEvent(config.inboundClaimsDir, eventKey, {
      peerId: inbound.peerId,
      messageId: inbound.meta?.messageId || '',
      eventId: inbound.meta?.eventId || '',
    }, ttlMs);
    if (!fileClaim.accepted) {
      for (const claimedEntry of claimedEntries) {
        await releaseInboundEventClaim(claimedEntry.claimFile);
      }
      return { accepted: false, eventKey, eventKeys, reason: fileClaim.reason };
    }
    claimedEntries.push({ eventKey, claimFile: fileClaim.filePath });
  }

  for (const claimedEntry of claimedEntries) {
    inboundState.events[claimedEntry.eventKey] = {
      status: 'processing',
      updatedAt: now,
      peerId: inbound.peerId,
      messageId: inbound.meta?.messageId || '',
      eventId: inbound.meta?.eventId || '',
      claimFile: claimedEntry.claimFile,
      relatedEventKeys: eventKeys,
    };
  }
  await persistInboundState();
  return { accepted: true, eventKey: eventKeys[0], eventKeys, claimFiles: claimedEntries.map((item) => item.claimFile) };
}

async function markInboundReplied(eventKey) {
  const existing = inboundState.events[eventKey] || {};
  const relatedEventKeys = Array.isArray(existing.relatedEventKeys) && existing.relatedEventKeys.length > 0
    ? existing.relatedEventKeys
    : [eventKey];
  const updatedAt = Date.now();

  for (const relatedKey of relatedEventKeys) {
    const relatedExisting = inboundState.events[relatedKey] || {};
    inboundState.events[relatedKey] = {
      ...relatedExisting,
      status: 'replied',
      updatedAt,
      relatedEventKeys,
    };
    if (relatedExisting.claimFile) {
      await updateInboundEventClaim(relatedExisting.claimFile, { status: 'replied' });
    }
  }
  await persistInboundState();
}

async function releaseInboundClaim(eventKey) {
  const existing = inboundState.events[eventKey];
  const relatedEventKeys = Array.isArray(existing?.relatedEventKeys) && existing.relatedEventKeys.length > 0
    ? existing.relatedEventKeys
    : [eventKey];

  for (const relatedKey of relatedEventKeys) {
    const relatedExisting = inboundState.events[relatedKey];
    if (relatedExisting?.claimFile) {
      await releaseInboundEventClaim(relatedExisting.claimFile);
    }
    delete inboundState.events[relatedKey];
  }
  await persistInboundState();
}

const bridge = await startFeishuBridge(config.feishu, config.mediaDir, async (inbound) => {
  const now = Date.now();
  pruneRecentInbound(now);
  pruneInboundState(now);
  pruneRecentMedia(now);
  const claim = await claimInbound(inbound);
  if (!claim.accepted) {
    console.log(`[bridge] duplicate inbound skipped for ${inbound.peerId} (${claim.reason}) matched_key=${claim.eventKey || '-'} message_id=${inbound.meta?.messageId || '-'} event_id=${inbound.meta?.eventId || '-'} keys=${(claim.eventKeys || []).join(',') || '-'} fingerprint=${buildInboundContentFingerprint(inbound)}`);
    return;
  }

  console.log(`[bridge] inbound from ${inbound.peerId}: ${inbound.text} message_id=${inbound.meta?.messageId || '-'} event_id=${inbound.meta?.eventId || '-'} keys=${claim.eventKeys.join(',')}`);

  if ((inbound.attachments?.length || 0) > 0 && isPlaceholderOnlyMessage(inbound.text)) {
    queuePendingMedia(inbound.peerId, inbound);
    console.log(`[bridge] queued media placeholder for ${inbound.peerId}`);
    await markInboundReplied(claim.eventKey);
    return;
  }

  await enqueue(inbound.peerId, async () => {
    const queuedAttachments = await waitForPendingMedia(inbound.peerId);
    const directAttachments = inbound.attachments || [];
    const fallbackRecentMedia = queuedAttachments.length === 0 && directAttachments.length === 0 && shouldUseRecentMedia(inbound.text)
      ? getRecentMediaForPeer(inbound.peerId)
      : [];
    const mergedAttachments = [
      ...queuedAttachments,
      ...directAttachments,
      ...fallbackRecentMedia,
    ];
    const effectiveInbound = {
      ...inbound,
      attachments: mergedAttachments,
    };

    const history = await loadConversation(config.sessionsDir, inbound.peerId);
    const historyLimit = effectiveInbound.attachments?.length
      ? Math.min(backendConfig.historyLimit, backendConfig.imageHistoryLimit)
      : backendConfig.historyLimit;
    const trimmedHistory = history.slice(-historyLimit);

    let reply;
    try {
      reply = await runReply(backendConfig, trimmedHistory, effectiveInbound);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] ${config.backend} failed for ${inbound.peerId}: ${message}`);
      const fallbackReply = {
        text: `抱歉，我刚刚处理这条消息超时或失败了。请你再发一次，或者把问题说得更短一点。错误: ${message}`,
        media: [],
        raw: '',
      };
      try {
        await bridge.sendReply(inbound.meta.senderOpenId || inbound.peerId, fallbackReply, {
          messageId: inbound.meta.messageId,
        });
        await markInboundReplied(claim.eventKey);
      } catch (sendError) {
        await releaseInboundClaim(claim.eventKey);
        throw sendError;
      }
      return;
    }

    const userText = [effectiveInbound.text, summarizeAttachments(effectiveInbound.attachments)].filter(Boolean).join('\n');
    const updated = appendConversation(trimmedHistory, { role: 'user', text: userText, timestamp: Date.now() }, backendConfig.historyLimit * 2);
    const assistantText = [reply.text, ...(reply.media || []).map((item) => `[[${item.kind}:${item.path}]]`)].filter(Boolean).join('\n');
    const finalHistory = appendConversation(updated, { role: 'assistant', text: assistantText, timestamp: Date.now() }, backendConfig.historyLimit * 2);
    await saveConversation(config.sessionsDir, inbound.peerId, finalHistory);

    try {
      await bridge.sendReply(inbound.meta.senderOpenId || inbound.peerId, reply, {
        messageId: inbound.meta.messageId,
      });
      await markInboundReplied(claim.eventKey);
    } catch (sendError) {
      await releaseInboundClaim(claim.eventKey);
      throw sendError;
    }
    console.log(`[bridge] replied to ${inbound.peerId} message_id=${inbound.meta?.messageId || '-'} event_id=${inbound.meta?.eventId || '-'} keys=${claim.eventKeys.join(',')}`);
  });
});

console.log('[bridge] feishu-cli-bridge started');
console.log(`[bridge] backend: ${config.backend}`);
console.log(`[bridge] backend model: ${backendConfig.model || '<cli-default>'}`);
console.log(`[bridge] sessions dir: ${config.sessionsDir}`);
console.log(`[bridge] media dir: ${config.mediaDir}`);
console.log(`[bridge] process pid: ${process.pid}`);

const shutdown = async () => {
  await releaseProcessLock().catch(() => {});
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
