import { buildReplyTarget } from './feishu-adapter.js';
import {
  buildSessionKey,
  classifyInboundMessage,
  isDelegateMessage,
} from './group-routing.js';
import {
  consumeEarlyResult,
  createDelegationTask,
  loadPendingTasks,
  markTaskStatus,
  pruneExpiredEarlyResults,
  pruneExpiredPendingTasks,
  savePendingTasks,
  upsertEarlyResult,
} from './pending-task-store.js';

const DELEGATE_TASK_RE = /^\s*\[delegate\]\s*\[task:([a-z0-9_-]+)\]\s*/i;

function extractDelegateTaskId(text = '') {
  return text.match(DELEGATE_TASK_RE)?.[1] || '';
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

    markTaskStatus(taskState, taskId, 'completed', { now: now() });
    await persistTaskState();
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
        await sendReplyForInbound(inbound, reply, { messageId: inbound.meta.messageId });
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
    const sessionKey = buildSessionKey({
      ...route,
      chatId: inbound.meta.chatId,
      senderOpenId: inbound.meta.senderOpenId,
      selfBotOpenId,
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
      },
    };

    let reply;
    try {
      reply = await runReply(backendConfig, trimmedHistory, effectiveInbound);
    } catch (error) {
      await sendReplyForInbound(inbound, buildFailureReply(route, route.taskId, error), {
        messageId: inbound.meta.messageId,
      });
      return;
    }

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
    await processModelReply(inbound, route, reply);
  }

  async function handleInbound(inbound) {
    const taskId = extractDelegateTaskId(inbound.text) || '';
    const resultTaskId = inbound.text?.match(/^\s*\[task:([a-z0-9_-]+)\]\s*/i)?.[1] || '';
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

    if (route.kind === 'ignore') {
      return { route };
    }

    if (route.kind === 'group_delegate_result') {
      await reconcilePendingTaskResult(route.taskId, inbound);
      return { route };
    }

    if (route.kind === 'group_discussion_request') {
      return { route, deferred: true };
    }

    const queueKey = buildSessionKey({
      ...route,
      chatId: inbound.meta.chatId,
      senderOpenId: inbound.meta.senderOpenId,
      selfBotOpenId,
      taskId: route.taskId || taskId,
    });
    await enqueue(queueKey, () => runReplyForInbound(inbound, route));
    return { route };
  }

  async function sweepTimeouts() {
    const currentTime = now();
    const timedOutTasks = pruneExpiredPendingTasks(taskState, currentTime);
    pruneExpiredEarlyResults(taskState, currentTime);
    await persistTaskState();

    for (const task of timedOutTasks) {
      if (task.kind !== 'delegation') {
        continue;
      }
      await bridge.sendReply({
        receiveIdType: 'chat_id',
        receiveId: task.chatId,
      }, buildTimeoutNotice(task.taskId), {
        messageId: task.originMessageId,
      });
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
