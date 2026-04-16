import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadPendingTasks,
  savePendingTasks,
  createDelegationTask,
  createDiscussionTask,
  upsertEarlyResult,
  consumeEarlyResult,
  markTaskStatus,
  setDiscussionPhase,
  incrementBotMessageCount,
  pruneExpiredPendingTasks,
  pruneExpiredEarlyResults,
} from '../src/pending-task-store.js';

test('loadPendingTasks returns an empty state for a missing file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-task-store-'));
  const filePath = path.join(dir, 'pending.json');

  const state = await loadPendingTasks(filePath);

  assert.deepEqual(state, { tasks: {}, earlyResults: {} });
  await fs.rm(dir, { recursive: true, force: true });
});

test('savePendingTasks creates parent directories on Windows-safe paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-task-store-'));
  const filePath = path.join(dir, 'nested', 'pending.json');

  await savePendingTasks(filePath, { tasks: {}, earlyResults: {} });
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));

  assert.deepEqual(raw, { tasks: {}, earlyResults: {} });
  await fs.rm(dir, { recursive: true, force: true });
});

test('createDelegationTask stores a pending delegation record', () => {
  const state = { tasks: {}, earlyResults: {} };

  const task = createDelegationTask(state, {
    taskId: 'abc123',
    chatId: 'oc_chat',
    originMessageId: 'om_1',
    requesterOpenId: 'ou_user',
    createdAt: 100,
    deadlineAt: 500,
  });

  assert.deepEqual(task, {
    taskId: 'abc123',
    kind: 'delegation',
    chatId: 'oc_chat',
    originMessageId: 'om_1',
    requesterOpenId: 'ou_user',
    status: 'pending',
    createdAt: 100,
    deadlineAt: 500,
  });
  assert.equal(state.tasks.abc123.kind, 'delegation');
});

test('createDiscussionTask freezes policy and initializes active discussion state', () => {
  const state = { tasks: {}, earlyResults: {} };

  const task = createDiscussionTask(state, {
    taskId: 'disc123',
    chatId: 'oc_chat',
    originMessageId: 'om_1',
    requesterOpenId: 'ou_user',
    hostBotOpenId: 'ou_host',
    participantBotOpenIds: ['ou_a', 'ou_b'],
    createdAt: 1000,
    questionText: 'compare approaches',
    policy: {
      maxBotMessages: 20,
      maxDurationMs: 900000,
    },
  });

  assert.equal(task.status, 'active');
  assert.equal(task.phase, 'stance');
  assert.equal(task.deadlineAt, 901000);
  assert.deepEqual(task.stanceByParticipantBotOpenId, {});
  assert.deepEqual(task.unresponsiveParticipantBotOpenIds, []);
  assert.deepEqual(task.phaseSummaries, []);
  assert.deepEqual(task.recentEvents, []);
});

test('upsertEarlyResult stores unmatched task results with expiry and consumeEarlyResult removes them', () => {
  const state = { tasks: {}, earlyResults: {} };
  const envelope = { taskId: 'abc123', text: '[task:abc123] done' };

  upsertEarlyResult(state, envelope, { now: 1000, ttlMs: 30000 });
  assert.deepEqual(state.earlyResults.abc123, {
    taskId: 'abc123',
    receivedAt: 1000,
    expiresAt: 31000,
    envelope,
  });

  assert.deepEqual(consumeEarlyResult(state, 'abc123'), envelope);
  assert.equal(state.earlyResults.abc123, undefined);
});

test('markTaskStatus updates lifecycle status fields', () => {
  const state = {
    tasks: {
      abc123: {
        taskId: 'abc123',
        status: 'pending',
      },
    },
    earlyResults: {},
  };

  markTaskStatus(state, 'abc123', 'completed', { now: 5000 });

  assert.equal(state.tasks.abc123.status, 'completed');
  assert.equal(state.tasks.abc123.updatedAt, 5000);
});

test('setDiscussionPhase and incrementBotMessageCount update discussion progress', () => {
  const state = {
    tasks: {
      disc123: {
        taskId: 'disc123',
        kind: 'discussion',
        phase: 'stance',
        botMessageCount: 0,
      },
    },
    earlyResults: {},
  };

  setDiscussionPhase(state, 'disc123', 'cross_exam', { now: 1000 });
  incrementBotMessageCount(state, 'disc123');
  incrementBotMessageCount(state, 'disc123');

  assert.equal(state.tasks.disc123.phase, 'cross_exam');
  assert.equal(state.tasks.disc123.updatedAt, 1000);
  assert.equal(state.tasks.disc123.botMessageCount, 2);
});

test('pruneExpiredPendingTasks marks overdue delegation and discussion tasks as timed out', () => {
  const state = {
    tasks: {
      pendingDelegation: {
        taskId: 'pendingDelegation',
        kind: 'delegation',
        status: 'pending',
        deadlineAt: 99,
      },
      activeDiscussion: {
        taskId: 'activeDiscussion',
        kind: 'discussion',
        status: 'active',
        deadlineAt: 100,
      },
      completedTask: {
        taskId: 'completedTask',
        kind: 'delegation',
        status: 'completed',
        deadlineAt: 1,
      },
    },
    earlyResults: {},
  };

  const timedOut = pruneExpiredPendingTasks(state, 100);

  assert.deepEqual(timedOut.map(item => item.taskId).sort(), ['activeDiscussion', 'pendingDelegation']);
  assert.equal(state.tasks.pendingDelegation.status, 'timed_out');
  assert.equal(state.tasks.activeDiscussion.status, 'timed_out');
  assert.equal(state.tasks.completedTask.status, 'completed');
});

test('pruneExpiredEarlyResults removes stale unmatched results', () => {
  const state = {
    tasks: {},
    earlyResults: {
      keep: {
        taskId: 'keep',
        receivedAt: 100,
        expiresAt: 200,
        envelope: { taskId: 'keep' },
      },
      drop: {
        taskId: 'drop',
        receivedAt: 100,
        expiresAt: 199,
        envelope: { taskId: 'drop' },
      },
    },
  };

  const pruned = pruneExpiredEarlyResults(state, 199);

  assert.deepEqual(pruned.map(item => item.taskId), ['drop']);
  assert.equal(state.earlyResults.keep.taskId, 'keep');
  assert.equal(state.earlyResults.drop, undefined);
});
