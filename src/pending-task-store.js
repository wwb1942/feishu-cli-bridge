import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_EARLY_RESULT_TTL_MS = 30_000;
const DEFAULT_RECENT_EVENTS_CAP = 10;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timed_out']);

function normalizeState(state) {
  return {
    tasks: state?.tasks && typeof state.tasks === 'object' ? state.tasks : {},
    earlyResults: state?.earlyResults && typeof state.earlyResults === 'object' ? state.earlyResults : {},
  };
}

export async function loadPendingTasks(filePath) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return normalizeState(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { tasks: {}, earlyResults: {} };
    }
    throw error;
  }
}

export async function savePendingTasks(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(normalizeState(state), null, 2));
}

export function createDelegationTask(state, task) {
  const nextTask = {
    taskId: task.taskId,
    kind: 'delegation',
    chatId: task.chatId,
    originMessageId: task.originMessageId,
    requesterOpenId: task.requesterOpenId,
    status: 'pending',
    createdAt: task.createdAt,
    deadlineAt: task.deadlineAt,
  };
  state.tasks ||= {};
  state.tasks[nextTask.taskId] = nextTask;
  return nextTask;
}

export function createDiscussionTask(state, task) {
  const createdAt = Number(task.createdAt) || Date.now();
  const policy = {
    maxBotMessages: Number(task.policy?.maxBotMessages) || 20,
    maxDurationMs: Number(task.policy?.maxDurationMs) || 900_000,
  };
  const nextTask = {
    taskId: task.taskId,
    kind: 'discussion',
    chatId: task.chatId,
    originMessageId: task.originMessageId,
    requesterOpenId: task.requesterOpenId,
    status: 'active',
    createdAt,
    deadlineAt: createdAt + policy.maxDurationMs,
    hostBotOpenId: task.hostBotOpenId,
    participantBotOpenIds: [...(task.participantBotOpenIds || [])],
    phase: 'stance',
    botMessageCount: 0,
    questionText: task.questionText || '',
    stanceByParticipantBotOpenId: { ...(task.stanceByParticipantBotOpenId || {}) },
    unresponsiveParticipantBotOpenIds: [...(task.unresponsiveParticipantBotOpenIds || [])],
    phaseSummaries: [...(task.phaseSummaries || [])],
    recentEvents: [...(task.recentEvents || [])].slice(-DEFAULT_RECENT_EVENTS_CAP),
    policy,
  };
  state.tasks ||= {};
  state.tasks[nextTask.taskId] = nextTask;
  return nextTask;
}

export function upsertEarlyResult(state, envelope, options = {}) {
  const now = Number(options.now) || Date.now();
  const ttlMs = Number(options.ttlMs) || DEFAULT_EARLY_RESULT_TTL_MS;
  const taskId = envelope?.taskId;
  if (!taskId) {
    return null;
  }
  const earlyResult = {
    taskId,
    receivedAt: now,
    expiresAt: now + ttlMs,
    envelope,
  };
  state.earlyResults ||= {};
  state.earlyResults[taskId] = earlyResult;
  return earlyResult;
}

export function consumeEarlyResult(state, taskId) {
  const earlyResult = state.earlyResults?.[taskId];
  if (!earlyResult) {
    return null;
  }
  delete state.earlyResults[taskId];
  return earlyResult.envelope;
}

export function markTaskStatus(state, taskId, status, options = {}) {
  const task = state.tasks?.[taskId];
  if (!task) {
    return null;
  }
  const now = Number(options.now) || Date.now();
  task.status = status;
  task.updatedAt = now;
  if (TERMINAL_STATUSES.has(status)) {
    task.completedAt = now;
  }
  return task;
}

export function setDiscussionPhase(state, taskId, phase, options = {}) {
  const task = state.tasks?.[taskId];
  if (!task) {
    return null;
  }
  const now = Number(options.now) || Date.now();
  task.phase = phase;
  task.updatedAt = now;
  return task;
}

export function incrementBotMessageCount(state, taskId, amount = 1) {
  const task = state.tasks?.[taskId];
  if (!task) {
    return null;
  }
  task.botMessageCount = Number(task.botMessageCount || 0) + amount;
  return task;
}

export function pruneExpiredPendingTasks(state, now = Date.now()) {
  const timedOut = [];
  for (const task of Object.values(state.tasks || {})) {
    if (!task) {
      continue;
    }
    if (!['pending', 'active'].includes(task.status)) {
      continue;
    }
    if (Number(task.deadlineAt) > 0 && Number(task.deadlineAt) <= now) {
      task.status = 'timed_out';
      task.updatedAt = now;
      task.completedAt = now;
      timedOut.push(task);
    }
  }
  return timedOut;
}

export function pruneExpiredEarlyResults(state, now = Date.now()) {
  const pruned = [];
  for (const [taskId, earlyResult] of Object.entries(state.earlyResults || {})) {
    if (Number(earlyResult?.expiresAt) <= now) {
      pruned.push(earlyResult);
      delete state.earlyResults[taskId];
    }
  }
  return pruned;
}
