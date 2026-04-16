import fs from 'node:fs/promises';
import path from 'node:path';
import { startFeishuBridge } from './feishu-adapter.js';
import { createBridgeRuntime } from './bridge-runtime.js';
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

const MEDIA_PLACEHOLDER_RE = /^\[(image|file|audio|media|message)\]$/i;
const RECENT_MEDIA_TTL_MS = 10 * 60 * 1000;
const IMAGE_REFERENCE_RE = /(这张|图片|图里|截图|这幅|这图|photo|image|picture|attachment|附件)/i;

function isPlaceholderOnlyMessage(text) {
  return MEDIA_PLACEHOLDER_RE.test((text || '').trim());
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

function buildPendingTasksFile(config) {
  if (config.pendingTasksFile) {
    return config.pendingTasksFile;
  }
  if (config.dataDir) {
    return path.join(config.dataDir, 'pending-tasks.json');
  }
  return path.join(path.dirname(config.sessionsDir), 'pending-tasks.json');
}

export async function startBridgeApp(options) {
  const config = options.config;
  const backendConfig = options.backendConfig;
  const runReply = options.runReply;
  const startBridge = options.startBridge || startFeishuBridge;
  const createRuntime = options.createRuntime || createBridgeRuntime;
  const ensureSessionStoreImpl = options.ensureSessionStore || ensureSessionStore;
  const acquireProcessLockImpl = options.acquireProcessLock || acquireProcessLock;
  const loadInboundStateImpl = options.loadInboundState || loadInboundState;
  const saveInboundStateImpl = options.saveInboundState || saveInboundState;
  const claimInboundEventImpl = options.claimInboundEvent || claimInboundEvent;
  const updateInboundEventClaimImpl = options.updateInboundEventClaim || updateInboundEventClaim;
  const releaseInboundEventClaimImpl = options.releaseInboundEventClaim || releaseInboundEventClaim;
  const loadConversationImpl = options.loadConversation || loadConversation;
  const saveConversationImpl = options.saveConversation || saveConversation;
  const appendConversationImpl = options.appendConversation || appendConversation;
  const fsImpl = options.fsImpl || fs;
  const now = options.now || (() => Date.now());
  const mediaMergeWaitMs = options.mediaMergeWaitMs ?? 1200;
  const mediaMergePollMs = options.mediaMergePollMs ?? 150;

  await ensureSessionStoreImpl(config.sessionsDir);
  await fsImpl.mkdir(config.mediaDir, { recursive: true });
  const releaseProcessLock = await acquireProcessLockImpl(config.processLockFile);
  const inboundState = await loadInboundStateImpl(config.inboundStateFile);

  const queues = new Map();
  const pendingMedia = new Map();
  const recentMedia = new Map();
  const recentInbound = new Map();

  function enqueue(peerId, task) {
    const previous = queues.get(peerId) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(peerId, next.catch(() => {}));
    return next;
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
      rememberedAt: now(),
    }))].slice(-8);
    recentMedia.set(peerId, next);
  }

  function pruneRecentMedia(currentTime = now()) {
    for (const [peerId, entries] of recentMedia.entries()) {
      const filtered = entries.filter((entry) => currentTime - (entry.rememberedAt || 0) <= RECENT_MEDIA_TTL_MS);
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
    if (entries.length === 0) {
      return [];
    }
    const { rememberedAt, ...attachment } = entries[entries.length - 1];
    return [attachment];
  }

  async function waitForPendingMedia(peerId) {
    const deadline = now() + mediaMergeWaitMs;
    while (now() < deadline) {
      const attachments = pendingMedia.get(peerId);
      if (attachments && attachments.length > 0) {
        return consumePendingMedia(peerId);
      }
      await new Promise((resolve) => setTimeout(resolve, mediaMergePollMs));
    }
    return consumePendingMedia(peerId);
  }

  function pruneRecentInbound(currentTime = now()) {
    for (const [key, timestamp] of recentInbound.entries()) {
      if (currentTime - timestamp > config.feishu.inboundDedupWindowMs) {
        recentInbound.delete(key);
      }
    }
  }

  function pruneInboundState(currentTime = now()) {
    for (const [key, entry] of Object.entries(inboundState.events || {})) {
      if (!entry || typeof entry !== 'object') {
        delete inboundState.events[key];
        continue;
      }
      const updatedAt = Number(entry.updatedAt) || 0;
      const ttl = entry.status === 'replied'
        ? config.feishu.inboundRepliedTtlMs
        : config.feishu.inboundProcessingTtlMs;
      if (currentTime - updatedAt > ttl) {
        delete inboundState.events[key];
      }
    }
  }

  async function persistInboundState() {
    await saveInboundStateImpl(config.inboundStateFile, inboundState);
  }

  async function claimInbound(inbound) {
    const currentTime = now();
    const eventKeys = getInboundEventKeys(inbound);

    for (const eventKey of eventKeys) {
      const recentSeenAt = recentInbound.get(eventKey);
      if (recentSeenAt && currentTime - recentSeenAt < config.feishu.inboundDedupWindowMs) {
        return { accepted: false, eventKey, eventKeys, reason: 'memory-window' };
      }
    }

    for (const eventKey of eventKeys) {
      const existing = inboundState.events[eventKey];
      if (existing?.status === 'replied' && currentTime - (Number(existing.updatedAt) || 0) < config.feishu.inboundRepliedTtlMs) {
        recentInbound.set(eventKey, currentTime);
        return { accepted: false, eventKey, eventKeys, reason: 'already-replied' };
      }

      if (existing?.status === 'processing' && currentTime - (Number(existing.updatedAt) || 0) < config.feishu.inboundProcessingTtlMs) {
        recentInbound.set(eventKey, currentTime);
        return { accepted: false, eventKey, eventKeys, reason: 'already-processing' };
      }
    }

    for (const eventKey of eventKeys) {
      recentInbound.set(eventKey, currentTime);
    }

    const claimedEntries = [];
    for (const eventKey of eventKeys) {
      const existing = inboundState.events[eventKey];
      const ttlMs = existing?.status === 'replied'
        ? config.feishu.inboundRepliedTtlMs
        : config.feishu.inboundProcessingTtlMs;
      const fileClaim = await claimInboundEventImpl(config.inboundClaimsDir, eventKey, {
        peerId: inbound.peerId,
        messageId: inbound.meta?.messageId || '',
        eventId: inbound.meta?.eventId || '',
      }, ttlMs);
      if (!fileClaim.accepted) {
        for (const claimedEntry of claimedEntries) {
          await releaseInboundEventClaimImpl(claimedEntry.claimFile);
        }
        return { accepted: false, eventKey, eventKeys, reason: fileClaim.reason };
      }
      claimedEntries.push({ eventKey, claimFile: fileClaim.filePath });
    }

    for (const claimedEntry of claimedEntries) {
      inboundState.events[claimedEntry.eventKey] = {
        status: 'processing',
        updatedAt: currentTime,
        peerId: inbound.peerId,
        messageId: inbound.meta?.messageId || '',
        eventId: inbound.meta?.eventId || '',
        claimFile: claimedEntry.claimFile,
        relatedEventKeys: eventKeys,
      };
    }
    await persistInboundState();
    return {
      accepted: true,
      eventKey: eventKeys[0],
      eventKeys,
      claimFiles: claimedEntries.map((item) => item.claimFile),
    };
  }

  async function markInboundReplied(eventKey) {
    const existing = inboundState.events[eventKey] || {};
    const relatedEventKeys = Array.isArray(existing.relatedEventKeys) && existing.relatedEventKeys.length > 0
      ? existing.relatedEventKeys
      : [eventKey];
    const updatedAt = now();

    for (const relatedKey of relatedEventKeys) {
      const relatedExisting = inboundState.events[relatedKey] || {};
      inboundState.events[relatedKey] = {
        ...relatedExisting,
        status: 'replied',
        updatedAt,
        relatedEventKeys,
      };
      if (relatedExisting.claimFile) {
        await updateInboundEventClaimImpl(relatedExisting.claimFile, { status: 'replied' });
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
        await releaseInboundEventClaimImpl(relatedExisting.claimFile);
      }
      delete inboundState.events[relatedKey];
    }
    await persistInboundState();
  }

  let bridgeRef;
  let runtimeRef;
  let resolveRuntimeReady;
  let rejectRuntimeReady;
  const runtimeReady = new Promise((resolve, reject) => {
    resolveRuntimeReady = resolve;
    rejectRuntimeReady = reject;
  });

  const bridge = await startBridge(config.feishu, config.mediaDir, async (inbound) => {
    const runtime = await runtimeReady;
    await runtime.sweepTimeouts();

    const currentTime = now();
    pruneRecentInbound(currentTime);
    pruneInboundState(currentTime);
    pruneRecentMedia(currentTime);

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
      const effectiveInbound = {
        ...inbound,
        attachments: [
          ...queuedAttachments,
          ...directAttachments,
          ...fallbackRecentMedia,
        ],
      };

      try {
        await runtime.handleInbound(effectiveInbound);
        await markInboundReplied(claim.eventKey);
      } catch (error) {
        await releaseInboundClaim(claim.eventKey);
        throw error;
      }

      console.log(`[bridge] replied to ${inbound.peerId} message_id=${inbound.meta?.messageId || '-'} event_id=${inbound.meta?.eventId || '-'} keys=${claim.eventKeys.join(',')} attachments=${summarizeAttachments(effectiveInbound.attachments) || '(none)'}`);
    });
  });

  bridgeRef = bridge;

  try {
    runtimeRef = await createRuntime({
      config: {
        ...config,
        pendingTasksFile: buildPendingTasksFile(config),
      },
      backendConfig,
      runReply,
      bridge: {
        sendReply: (...args) => bridgeRef.sendReply(...args),
      },
      loadConversation: loadConversationImpl,
      saveConversation: saveConversationImpl,
      appendConversation: appendConversationImpl,
    });
    resolveRuntimeReady(runtimeRef);
  } catch (error) {
    rejectRuntimeReady(error);
    await releaseProcessLock().catch(() => {});
    throw error;
  }

  return {
    bridge: bridgeRef,
    runtime: runtimeRef,
    async shutdown() {
      await runtimeRef?.stop?.().catch(() => {});
      await releaseProcessLock().catch(() => {});
    },
  };
}
