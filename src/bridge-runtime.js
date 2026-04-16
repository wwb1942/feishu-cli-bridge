import { buildReplyTarget } from './feishu-adapter.js';
import {
  buildSessionKey,
  classifyInboundMessage,
  generateTaskId,
  isDelegateMessage,
} from './group-routing.js';
import {
  appendDiscussionEvent,
  buildDiscussionContext,
  clearDiscussionParticipantPending,
  consumeEarlyResult,
  createDelegationTask,
  createDiscussionTask,
  incrementBotMessageCount,
  isDiscussionGuardrailReached,
  loadPendingTasks,
  markDiscussionParticipantsPending,
  markTimedOutDiscussionParticipants,
  markTaskStatus,
  pruneExpiredEarlyResults,
  pruneExpiredPendingTasks,
  recordDiscussionParticipantResult,
  savePendingTasks,
  setDiscussionPhase,
  summarizePhaseOutcome,
  upsertEarlyResult,
} from './pending-task-store.js';
import { parseDiscussionControlReply } from './runner-utils.js';

const DELEGATE_TASK_RE = /^\s*\[delegate\]\s*\[task:([a-z0-9_-]+)\]\s*/i;
const RESULT_TASK_RE = /^\s*\[task:([a-z0-9_-]+)\]\s*/i;
const OPEN_ID_MENTION_RE = /@((?:ou|on)_[A-Za-z0-9_-]+)/g;

function extractDelegateTaskId(text = '') {
  return text.match(DELEGATE_TASK_RE)?.[1] || '';
}

function extractResultTaskId(text = '') {
  return text.match(RESULT_TASK_RE)?.[1] || '';
}

function stripLeadingTaskMarker(text = '') {
  return text.replace(RESULT_TASK_RE, '').trim();
}

function extractMentionOpenIdsFromText(text = '') {
  return [...text.matchAll(OPEN_ID_MENTION_RE)]
    .map((match) => match[1])
    .filter((value, index, list) => list.indexOf(value) === index);
}

function summarizeAttachments(attachments) {
  if (!attachments?.length) {
    return '';
  }
  return attachments.map((attachment) => `[${attachment.kind}] ${attachment.path}`).join('\n');
}

function buildAssistantHistoryEntry(reply) {
  return [reply.text, ...(reply.media || []).map((item) => `[[${item.kind}:${item.path}]]`)]
    .filter(Boolean)
    .join('\n');
}

function buildFailureReply(route, taskId, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (route.kind === 'group_delegate_request' && taskId) {
    return {
      text: `[task:${taskId}] failed: ${message}`,
      media: [],
      raw: '',
    };
  }

  return {
    text: `Request failed: ${message}`,
    media: [],
    raw: '',
  };
}

function buildDelegationConfirmation(taskId) {
  return {
    text: `Delegated for [task:${taskId}]`,
    media: [],
    raw: '',
  };
}

function buildDelegationSendFailure(taskId, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    text: `Delegation failed for [task:${taskId}]: ${message}`,
    media: [],
    raw: '',
  };
}

function buildTimeoutNotice(taskId) {
  return {
    text: `Task [task:${taskId}] timed out while waiting for a delegated result.`,
    media: [],
    raw: '',
  };
}

function buildDiscussionDelegationReply(task, delegation) {
  return {
    text: `[delegate] [task:${task.taskId}] @${delegation.targetBotOpenId} Original question: ${task.questionText}\nRequested focus: ${delegation.instruction}`,
    media: [],
    raw: '',
  };
}

function buildDiscussionForcedVerdict(task, reason) {
  const stanceLines = Object.entries(task.stanceByParticipantBotOpenId || {})
    .map(([botOpenId, stance]) => `${botOpenId}: ${stance}`)
    .join('; ');
  const unresponsive = (task.unresponsiveParticipantBotOpenIds || []).join(', ');
  const details = [
    stanceLines ? `Available stances: ${stanceLines}.` : 'No participant stances were captured.',
    unresponsive ? `Unresponsive participants: ${unresponsive}.` : '',
  ].filter(Boolean).join(' ');

  return {
    text: `Forced verdict for [task:${task.taskId}]: ${reason}${details ? ` ${details}` : ''}`,
    media: [],
    raw: '',
  };
}

function buildDiscussionFailureNotice(task, reason) {
  return {
    text: `Discussion orchestration failed for [task:${task.taskId}]: ${reason}`,
    media: [],
    raw: '',
  };
}

function createNoopIntervalHandle() {
  return {
    unref() {},
  };
}

export async function createBridgeRuntime(deps) {
  const config = deps.config;
  const backendConfig = deps.backendConfig;
  const runReply = deps.runReply;
  const bridge = deps.bridge;
  const loadConversation = deps.loadConversation;
  const saveConversation = deps.saveConversation;
  const appendConversation = deps.appendConversation;
  const loadPendingTasksImpl = deps.loadPendingTasks || loadPendingTasks;
  const savePendingTasksImpl = deps.savePendingTasks || savePendingTasks;
  const now = deps.now || (() => Date.now());
  const setIntervalImpl = deps.setIntervalImpl || setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl || clearInterval;

  const queues = new Map();
  const taskState = await loadPendingTasksImpl(config.pendingTasksFile);
  const selfBotOpenId = config.feishu.botOpenId;

  async function persistTaskState() {
    await savePendingTasksImpl(config.pendingTasksFile, taskState);
  }

  function enqueue(sessionKey, task) {
    const previous = queues.get(sessionKey) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(sessionKey, next.catch(() => {}));
    return next;
  }

  async function sendReplyForInbound(inbound, reply, replyMeta) {
    const target = buildReplyTarget(inbound.meta);
    await bridge.sendReply(target, reply, replyMeta);
  }

  async function sendReplyToChat(chatId, reply, replyMeta = {}) {
    await bridge.sendReply({
      receiveIdType: 'chat_id',
      receiveId: chatId,
    }, reply, replyMeta);
  }

  async function executeModel(inbound, route, extraMeta = {}) {
    const sessionKey = buildSessionKey({
      ...route,
      chatId: inbound.meta.chatId,
      senderOpenId: inbound.meta.senderOpenId,
      selfBotOpenId,
      taskId: route.taskId,
    });
    const history = await loadConversation(config.sessionsDir, sessionKey);
    const historyLimit = inbound.attachments?.length
      ? Math.min(backendConfig.historyLimit, backendConfig.imageHistoryLimit)
      : backendConfig.historyLimit;
    const trimmedHistory = history.slice(-historyLimit);
    const effectiveInbound = {
      ...inbound,
      peerId: sessionKey,
      meta: {
        ...inbound.meta,
        routeKind: route.kind,
        sessionKey,
        selfBotOpenId,
        taskId: route.taskId,
        ...extraMeta,
      },
    };

    const reply = await runReply(backendConfig, trimmedHistory, effectiveInbound);
    const userText = [effectiveInbound.text, summarizeAttachments(effectiveInbound.attachments)].filter(Boolean).join('\n');
    const updatedHistory = appendConversation(
      trimmedHistory,
      { role: 'user', text: userText, timestamp: now() },
      backendConfig.historyLimit * 2,
    );
    const finalHistory = appendConversation(
      updatedHistory,
      { role: 'assistant', text: buildAssistantHistoryEntry(reply), timestamp: now() },
      backendConfig.historyLimit * 2,
    );
    await saveConversation(config.sessionsDir, sessionKey, finalHistory);

    return {
      reply,
      effectiveInbound,
      sessionKey,
    };
  }

  function getDiscussionTask(taskId) {
    const task = taskState.tasks?.[taskId];
    return task?.kind === 'discussion' ? task : null;
  }

  function getDiscussionQueueKey(task) {
    return buildSessionKey({
      kind: 'group_discussion_request',
      chatId: task.chatId,
      senderOpenId: task.requesterOpenId,
      selfBotOpenId,
      taskId: task.taskId,
    });
  }

  async function finalizeDiscussionTask(taskId, reply, status, options = {}) {
    const task = getDiscussionTask(taskId);
    if (!task) {
      return;
    }

    setDiscussionPhase(taskState, taskId, 'verdict', { now: now() });
    markTaskStatus(taskState, taskId, status, { now: now() });
    appendDiscussionEvent(taskState, taskId, {
      type: 'host_decision',
      phase: 'verdict',
      actorBotOpenId: selfBotOpenId,
      summary: reply.text,
    }, { now: now() });
    summarizePhaseOutcome(taskState, taskId, reply.text, {
      now: now(),
      phase: 'verdict',
    });
    incrementBotMessageCount(taskState, taskId);
    await persistTaskState();
    await sendReplyToChat(task.chatId, reply, {
      messageId: options.messageId || task.originMessageId,
    });
  }

  async function finalizeDiscussionWithForcedVerdict(taskId, reason, status = 'timed_out', replyMeta = {}) {
    const task = getDiscussionTask(taskId);
    if (!task) {
      return;
    }
    await finalizeDiscussionTask(taskId, buildDiscussionForcedVerdict(task, reason), status, replyMeta);
  }

  async function sendDiscussionDelegations(taskId, delegations, replyMeta = {}) {
    const task = getDiscussionTask(taskId);
    if (!task || delegations.length === 0) {
      return;
    }

    const deadlineAt = now() + config.feishu.delegateTimeoutMs;
    markDiscussionParticipantsPending(
      taskState,
      taskId,
      delegations.map(item => item.targetBotOpenId),
      deadlineAt,
      { now: now() },
    );
    await persistTaskState();

    for (const delegation of delegations) {
      await sendReplyToChat(task.chatId, buildDiscussionDelegationReply(task, delegation), {
        messageId: replyMeta.messageId || task.originMessageId,
        mentionOpenIds: [delegation.targetBotOpenId],
      });
      appendDiscussionEvent(taskState, taskId, {
        type: 'delegation_sent',
        phase: task.phase,
        actorBotOpenId: selfBotOpenId,
        targetBotOpenId: delegation.targetBotOpenId,
        summary: delegation.instruction,
      }, { now: now() });
      incrementBotMessageCount(taskState, taskId);
    }

    await persistTaskState();
  }

  async function applyDiscussionControl(taskId, rawReply, replyMeta = {}) {
    const task = getDiscussionTask(taskId);
    if (!task) {
      return;
    }

    const parsed = parseDiscussionControlReply(rawReply.text || '');
    if (!parsed.hasMarker) {
      await finalizeDiscussionTask(taskId, {
        text: parsed.visibleText || rawReply.text || 'Discussion concluded.',
        media: rawReply.media || [],
        raw: rawReply.raw || '',
      }, 'completed', replyMeta);
      return;
    }

    if (parsed.malformed || !parsed.control) {
      if (parsed.visibleText) {
        await finalizeDiscussionTask(taskId, {
          text: parsed.visibleText,
          media: [],
          raw: '',
        }, 'completed', replyMeta);
        return;
      }
      await finalizeDiscussionTask(taskId, buildDiscussionFailureNotice(task, 'Malformed discussion control marker.'), 'completed', replyMeta);
      return;
    }

    setDiscussionPhase(taskState, taskId, parsed.control.nextPhase, { now: now() });
    appendDiscussionEvent(taskState, taskId, {
      type: 'host_decision',
      phase: parsed.control.nextPhase,
      actorBotOpenId: selfBotOpenId,
      summary: parsed.control.publicSummary || parsed.visibleText || `Advanced to ${parsed.control.nextPhase}.`,
    }, { now: now() });
    summarizePhaseOutcome(
      taskState,
      taskId,
      parsed.control.publicSummary || parsed.visibleText || `Advanced to ${parsed.control.nextPhase}.`,
      { now: now(), phase: parsed.control.nextPhase },
    );
    await persistTaskState();

    const guardrail = isDiscussionGuardrailReached(getDiscussionTask(taskId), now());
    if (guardrail.reached && parsed.control.delegations.length > 0) {
      await finalizeDiscussionWithForcedVerdict(
        taskId,
        `Discussion guardrail reached (${guardrail.reason}).`,
        'completed',
        replyMeta,
      );
      return;
    }

    if (parsed.control.delegations.length > 0) {
      await sendDiscussionDelegations(taskId, parsed.control.delegations, replyMeta);
      if (parsed.control.publicSummary) {
        await sendReplyToChat(task.chatId, {
          text: parsed.control.publicSummary,
          media: [],
          raw: '',
        }, {
          messageId: replyMeta.messageId || task.originMessageId,
        });
        appendDiscussionEvent(taskState, taskId, {
          type: 'system',
          phase: parsed.control.nextPhase,
          actorBotOpenId: selfBotOpenId,
          summary: parsed.control.publicSummary,
        }, { now: now() });
        incrementBotMessageCount(taskState, taskId);
        await persistTaskState();
      }
      return;
    }

    await finalizeDiscussionTask(taskId, {
      text: parsed.visibleText || parsed.control.publicSummary || 'Discussion concluded.',
      media: [],
      raw: '',
    }, 'completed', replyMeta);
  }

  async function orchestrateDiscussionTask(taskId, triggerMeta = {}) {
    const task = getDiscussionTask(taskId);
    if (!task || task.status !== 'active') {
      return;
    }

    if ((task.pendingParticipantBotOpenIds || []).length > 0) {
      return;
    }

    const guardrail = isDiscussionGuardrailReached(task, now());
    if (guardrail.reached) {
      await finalizeDiscussionWithForcedVerdict(
        taskId,
        `Discussion guardrail reached (${guardrail.reason}).`,
        guardrail.reason === 'duration' ? 'timed_out' : 'completed',
        triggerMeta,
      );
      return;
    }

    const inbound = {
      peerId: task.requesterOpenId,
      text: task.questionText,
      attachments: [],
      meta: {
        chatType: 'group',
        chatId: task.chatId,
        senderOpenId: task.requesterOpenId,
        senderType: 'USER',
        mentionOpenIds: [selfBotOpenId, ...(task.participantBotOpenIds || [])],
        messageId: triggerMeta.messageId || task.originMessageId,
        eventId: triggerMeta.eventId || '',
      },
    };

    try {
      const modelResult = await executeModel(
        inbound,
        { kind: 'group_discussion_request', taskId },
        {
          discussion: {
            role: 'host',
            ...buildDiscussionContext(task),
          },
        },
      );
      await applyDiscussionControl(taskId, modelResult.reply, {
        messageId: triggerMeta.messageId || task.originMessageId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finalizeDiscussionWithForcedVerdict(taskId, message, 'timed_out', {
        messageId: triggerMeta.messageId || task.originMessageId,
      });
    }
  }

  async function scheduleDiscussionOrchestration(taskId, triggerMeta = {}) {
    const task = getDiscussionTask(taskId);
    if (!task || task.status !== 'active') {
      return;
    }
    const queueKey = getDiscussionQueueKey(task);
    await enqueue(queueKey, () => orchestrateDiscussionTask(taskId, triggerMeta));
  }

  async function reconcileDiscussionTaskResult(taskId, inbound) {
    const task = getDiscussionTask(taskId);
    if (!task) {
      return;
    }

    const actorBotOpenId = inbound.meta.senderOpenId || '';
    recordDiscussionParticipantResult(
      taskState,
      taskId,
      actorBotOpenId,
      stripLeadingTaskMarker(inbound.text),
      { now: now() },
    );
    incrementBotMessageCount(taskState, taskId);
    await persistTaskState();

    if ((getDiscussionTask(taskId)?.pendingParticipantBotOpenIds || []).length === 0) {
      await scheduleDiscussionOrchestration(taskId, inbound.meta);
    }
  }

  async function reconcilePendingTaskResult(taskId, inbound) {
    const task = taskState.tasks?.[taskId];
    if (!task) {
      upsertEarlyResult(taskState, {
        taskId,
        text: inbound.text,
        meta: inbound.meta,
      }, {
        now: now(),
      });
      await persistTaskState();
      return;
    }

    if (task.kind === 'discussion') {
      await reconcileDiscussionTaskResult(taskId, inbound);
      return;
    }

    markTaskStatus(taskState, taskId, 'completed', { now: now() });
    await persistTaskState();
  }

  async function processModelReply(inbound, route, reply) {
    if (route.kind === 'group_user_request' && isDelegateMessage(reply.text)) {
      const taskId = extractDelegateTaskId(reply.text);
      const createdAt = now();
      createDelegationTask(taskState, {
        taskId,
        chatId: inbound.meta.chatId,
        originMessageId: inbound.meta.messageId,
        requesterOpenId: inbound.meta.senderOpenId,
        createdAt,
        deadlineAt: createdAt + config.feishu.delegateTimeoutMs,
      });

      const earlyResult = consumeEarlyResult(taskState, taskId);
      if (earlyResult) {
        markTaskStatus(taskState, taskId, 'completed', { now: now() });
      }

      await persistTaskState();

      try {
        await sendReplyForInbound(inbound, reply, {
          messageId: inbound.meta.messageId,
          mentionOpenIds: extractMentionOpenIdsFromText(reply.text),
        });
        await sendReplyForInbound(inbound, buildDelegationConfirmation(taskId), {
          messageId: inbound.meta.messageId,
        });
      } catch (error) {
        markTaskStatus(taskState, taskId, 'failed', { now: now() });
        await persistTaskState();
        await sendReplyForInbound(inbound, buildDelegationSendFailure(taskId, error), {
          messageId: inbound.meta.messageId,
        });
      }
      return;
    }

    await sendReplyForInbound(inbound, reply, { messageId: inbound.meta.messageId });
  }

  async function runReplyForInbound(inbound, route) {
    try {
      const modelResult = await executeModel(inbound, route);
      await processModelReply(inbound, route, modelResult.reply);
    } catch (error) {
      await sendReplyForInbound(inbound, buildFailureReply(route, route.taskId, error), {
        messageId: inbound.meta.messageId,
      });
    }
  }

  async function handleInbound(inbound) {
    const delegateTaskId = extractDelegateTaskId(inbound.text) || '';
    const resultTaskId = extractResultTaskId(inbound.text) || '';
    const pendingTask = taskState.tasks?.[resultTaskId] || null;
    const route = classifyInboundMessage({
      chatType: inbound.meta.chatType,
      senderType: inbound.meta.senderType,
      text: inbound.text,
      mentionOpenIds: inbound.meta.mentionOpenIds || [],
      selfBotOpenId,
      mentionOrderReliable: inbound.meta.mentionOrderReliable,
      discussionHostBotOpenId: config.feishu.discussionHostBotOpenId,
      pendingTask,
    });

    if (
      route.kind === 'ignore'
      && inbound.meta.chatType === 'group'
      && inbound.meta.senderType === 'ASSISTANT'
      && resultTaskId
    ) {
      await reconcilePendingTaskResult(resultTaskId, inbound);
      return {
        route: {
          kind: 'group_delegate_result',
          taskId: resultTaskId,
          hostBotOpenId: '',
        },
      };
    }

    if (route.kind === 'ignore') {
      return { route };
    }

    if (route.kind === 'group_delegate_result') {
      await reconcilePendingTaskResult(route.taskId, inbound);
      return { route };
    }

    if (route.kind === 'group_discussion_request') {
      const taskId = generateTaskId();
      createDiscussionTask(taskState, {
        taskId,
        chatId: inbound.meta.chatId,
        originMessageId: inbound.meta.messageId,
        requesterOpenId: inbound.meta.senderOpenId,
        hostBotOpenId: selfBotOpenId,
        participantBotOpenIds: (inbound.meta.mentionOpenIds || []).filter((botOpenId) => botOpenId !== selfBotOpenId),
        createdAt: now(),
        questionText: inbound.text,
        policy: {
          maxBotMessages: config.feishu.discussionMaxBotMessages,
          maxDurationMs: config.feishu.discussionMaxDurationMs,
        },
      });
      await persistTaskState();
      await scheduleDiscussionOrchestration(taskId, inbound.meta);
      return {
        route: {
          ...route,
          taskId,
        },
      };
    }

    const queueKey = buildSessionKey({
      ...route,
      chatId: inbound.meta.chatId,
      senderOpenId: inbound.meta.senderOpenId,
      selfBotOpenId,
      taskId: route.taskId || delegateTaskId,
    });
    await enqueue(queueKey, () => runReplyForInbound(inbound, route));
    return { route };
  }

  async function sweepTimeouts() {
    const currentTime = now();
    const timedOutTasks = pruneExpiredPendingTasks(taskState, currentTime);
    const timedOutDiscussionParticipants = markTimedOutDiscussionParticipants(taskState, currentTime);
    pruneExpiredEarlyResults(taskState, currentTime);
    await persistTaskState();

    for (const task of timedOutTasks) {
      if (task.kind === 'delegation') {
        await bridge.sendReply({
          receiveIdType: 'chat_id',
          receiveId: task.chatId,
        }, buildTimeoutNotice(task.taskId), {
          messageId: task.originMessageId,
        });
        continue;
      }

      if (task.kind === 'discussion') {
        await finalizeDiscussionWithForcedVerdict(
          task.taskId,
          'Discussion timed out before reaching a clean verdict.',
          'timed_out',
          { messageId: task.originMessageId },
        );
      }
    }

    for (const record of timedOutDiscussionParticipants) {
      if (record.readyForHost) {
        await scheduleDiscussionOrchestration(record.task.taskId, {
          messageId: record.task.originMessageId,
          eventId: '',
        });
      }
    }

    return timedOutTasks;
  }

  const sweeperHandle = config.feishu.groupDelegationEnabled
    ? setIntervalImpl(() => {
        Promise.resolve(sweepTimeouts()).catch(() => {});
      }, 5_000)
    : createNoopIntervalHandle();
  sweeperHandle?.unref?.();

  return {
    handleInbound,
    sweepTimeouts,
    async stop() {
      clearIntervalImpl(sweeperHandle);
      await persistTaskState();
    },
  };
}
