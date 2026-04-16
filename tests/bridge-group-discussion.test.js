import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeHarness } from './helpers/bridge-harness.js';

function makeInbound(overrides = {}) {
  const { meta: metaOverrides = {}, ...restOverrides } = overrides;
  const meta = {
    chatType: 'group',
    chatId: 'oc_chat',
    senderOpenId: 'ou_user',
    senderType: 'USER',
    mentionOpenIds: ['ou_bot'],
    messageId: 'om_1',
    eventId: 'oe_1',
    ...metaOverrides,
  };

  return {
    peerId: meta.senderOpenId,
    text: '@bot discuss this',
    attachments: [],
    meta,
    ...restOverrides,
  };
}

function buildControlMarker(control) {
  return `[[discussion-control:${JSON.stringify(control)}]]`;
}

test('host discussion request creates task, uses a discussion session, and drives stance to cross-exam to verdict', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [
      {
        text: buildControlMarker({
          nextPhase: 'stance',
          delegations: [
            { targetBotOpenId: 'ou_a', instruction: 'Share your initial stance.' },
            { targetBotOpenId: 'ou_b', instruction: 'Share your initial stance.' },
          ],
          publicSummary: 'Collecting initial positions.',
        }),
        media: [],
        raw: '',
      },
      {
        text: buildControlMarker({
          nextPhase: 'cross_exam',
          delegations: [
            { targetBotOpenId: 'ou_a', instruction: 'Challenge bot B on the main disagreement.' },
          ],
          publicSummary: 'Examining the core disagreement.',
        }),
        media: [],
        raw: '',
      },
      {
        text: 'Final verdict: choose option B.',
        media: [],
        raw: 'Final verdict: choose option B.',
      },
    ],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot @a @b compare these approaches',
    meta: {
      mentionOpenIds: ['ou_bot', 'ou_a', 'ou_b'],
    },
  }));

  const [taskId] = Object.keys(harness.pendingState.tasks);
  const task = harness.pendingState.tasks[taskId];
  assert.equal(task.kind, 'discussion');
  assert.equal(task.status, 'active');
  assert.deepEqual(task.participantBotOpenIds, ['ou_a', 'ou_b']);
  assert.deepEqual(task.policy, { maxBotMessages: 20, maxDurationMs: 900000 });
  assert.equal(harness.runReplyCalls.length, 1);
  assert.equal(harness.runReplyCalls[0].inbound.meta.sessionKey, `group:oc_chat:discussion:${taskId}:host:ou_bot`);
  assert.equal(harness.runReplyCalls[0].inbound.meta.discussion.role, 'host');
  assert.equal(harness.sentReplies.length, 3);
  assert.match(harness.sentReplies[0].reply.text, new RegExp(`^\\[delegate\\] \\[task:${taskId}\\]`));
  assert.match(harness.sentReplies[1].reply.text, new RegExp(`^\\[delegate\\] \\[task:${taskId}\\]`));
  assert.equal(harness.sentReplies[2].reply.text, 'Collecting initial positions.');

  await harness.handleInbound(makeInbound({
    text: `[task:${taskId}] Bot A stance: option A`,
    meta: {
      senderType: 'ASSISTANT',
      senderOpenId: 'ou_a',
      mentionOpenIds: [],
      messageId: 'om_2',
      eventId: 'oe_2',
    },
  }));

  assert.equal(harness.runReplyCalls.length, 1);

  await harness.handleInbound(makeInbound({
    text: `[task:${taskId}] Bot B stance: option B`,
    meta: {
      senderType: 'ASSISTANT',
      senderOpenId: 'ou_b',
      mentionOpenIds: [],
      messageId: 'om_3',
      eventId: 'oe_3',
    },
  }));

  assert.equal(harness.runReplyCalls.length, 2);
  assert.deepEqual(
    harness.runReplyCalls[1].inbound.meta.discussion.stanceByParticipantBotOpenId,
    {
      ou_a: 'Bot A stance: option A',
      ou_b: 'Bot B stance: option B',
    },
  );
  assert.equal(harness.sentReplies.length, 5);
  assert.match(harness.sentReplies[3].reply.text, new RegExp(`^\\[delegate\\] \\[task:${taskId}\\]`));
  assert.equal(harness.sentReplies[4].reply.text, 'Examining the core disagreement.');

  await harness.handleInbound(makeInbound({
    text: `[task:${taskId}] Bot A revision: option B is safer`,
    meta: {
      senderType: 'ASSISTANT',
      senderOpenId: 'ou_a',
      mentionOpenIds: [],
      messageId: 'om_4',
      eventId: 'oe_4',
    },
  }));

  assert.equal(harness.runReplyCalls.length, 3);
  assert.equal(harness.sentReplies.at(-1).reply.text, 'Final verdict: choose option B.');
  assert.equal(harness.pendingState.tasks[taskId].status, 'completed');
});

test('non-host participant ignores the original human discussion request', async () => {
  const harness = await createBridgeHarness({
    config: {
      feishu: {
        botOpenId: 'ou_a',
      },
    },
  });

  await harness.handleInbound(makeInbound({
    text: '@host @a @b compare these approaches',
    meta: {
      mentionOpenIds: ['ou_bot', 'ou_a', 'ou_b'],
    },
  }));

  assert.equal(harness.runReplyCalls.length, 0);
  assert.equal(harness.sentReplies.length, 0);
  assert.deepEqual(harness.pendingState.tasks, {});
});

test('participant stance timeout marks that participant unresponsive and host continues with remaining input', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [
      {
        text: buildControlMarker({
          nextPhase: 'stance',
          delegations: [
            { targetBotOpenId: 'ou_a', instruction: 'Share your initial stance.' },
            { targetBotOpenId: 'ou_b', instruction: 'Share your initial stance.' },
          ],
          publicSummary: 'Collecting initial positions.',
        }),
        media: [],
        raw: '',
      },
      {
        text: 'Forced verdict: proceed with the available stance only.',
        media: [],
        raw: 'Forced verdict: proceed with the available stance only.',
      },
    ],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot @a @b compare these approaches',
    meta: {
      mentionOpenIds: ['ou_bot', 'ou_a', 'ou_b'],
    },
  }));

  const [taskId] = Object.keys(harness.pendingState.tasks);

  await harness.handleInbound(makeInbound({
    text: `[task:${taskId}] Bot A stance: option A`,
    meta: {
      senderType: 'ASSISTANT',
      senderOpenId: 'ou_a',
      mentionOpenIds: [],
      messageId: 'om_2',
      eventId: 'oe_2',
    },
  }));

  harness.advanceTime(6_000);
  await harness.sweep();

  assert.equal(harness.runReplyCalls.length, 2);
  assert.deepEqual(harness.pendingState.tasks[taskId].unresponsiveParticipantBotOpenIds, ['ou_b']);
  assert.deepEqual(harness.runReplyCalls[1].inbound.meta.discussion.unresponsiveParticipantBotOpenIds, ['ou_b']);
  assert.equal(harness.sentReplies.at(-1).reply.text, 'Forced verdict: proceed with the available stance only.');
  assert.equal(harness.pendingState.tasks[taskId].status, 'completed');
});

test('host runner timeout during discussion falls back to a forced verdict and closes the task as timed_out', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [new Error('host runner timed out after 5000ms')],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot @a @b compare these approaches',
    meta: {
      mentionOpenIds: ['ou_bot', 'ou_a', 'ou_b'],
    },
  }));

  const [taskId] = Object.keys(harness.pendingState.tasks);
  assert.equal(harness.runReplyCalls.length, 1);
  assert.equal(harness.pendingState.tasks[taskId].status, 'timed_out');
  assert.match(harness.sentReplies.at(-1).reply.text, /forced verdict|timed out|available input/i);
});

test('ordinary group user sessions stay isolated from hosted discussion sessions in the same chat', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [
      {
        text: 'Discussion verdict with no further coordination.',
        media: [],
        raw: 'Discussion verdict with no further coordination.',
      },
      {
        text: 'Ordinary group reply.',
        media: [],
        raw: 'Ordinary group reply.',
      },
    ],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot @a compare these approaches',
    meta: {
      mentionOpenIds: ['ou_bot', 'ou_a'],
    },
  }));

  const discussionSessionKey = harness.runReplyCalls[0].inbound.meta.sessionKey;
  assert.match(discussionSessionKey, /^group:oc_chat:discussion:/);

  await harness.handleInbound(makeInbound({
    text: '@bot ordinary follow-up',
    meta: {
      mentionOpenIds: ['ou_bot'],
      messageId: 'om_followup',
      eventId: 'oe_followup',
    },
  }));

  assert.equal(harness.runReplyCalls[1].inbound.meta.sessionKey, 'group:oc_chat:user:ou_user:bot:ou_bot');
  assert.notEqual(harness.runReplyCalls[1].inbound.meta.sessionKey, discussionSessionKey);
});

test('malformed host control marker falls back safely to a visible verdict instead of looping', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [{
      text: 'Fallback verdict after malformed control.\n[[discussion-control:{bad json}]]',
      media: [],
      raw: '',
    }],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot @a compare these approaches',
    meta: {
      mentionOpenIds: ['ou_bot', 'ou_a'],
    },
  }));

  const [taskId] = Object.keys(harness.pendingState.tasks);
  assert.equal(harness.runReplyCalls.length, 1);
  assert.equal(harness.pendingState.tasks[taskId].status, 'completed');
  assert.equal(harness.sentReplies.at(-1).reply.text, 'Fallback verdict after malformed control.');
});

test('host discussion context stays bounded to the most recent task events', async () => {
  const recentEvents = Array.from({ length: 12 }, (_, index) => ({
    type: 'participant_result',
    phase: 'cross_exam',
    actorBotOpenId: `ou_${index}`,
    summary: `event-${index}`,
    createdAt: 1000 + index,
  }));

  const harness = await createBridgeHarness({
    pendingState: {
      tasks: {
        disc123: {
          taskId: 'disc123',
          kind: 'discussion',
          chatId: 'oc_chat',
          originMessageId: 'om_disc',
          requesterOpenId: 'ou_user',
          hostBotOpenId: 'ou_bot',
          participantBotOpenIds: ['ou_a'],
          status: 'active',
          createdAt: 1000,
          deadlineAt: 901000,
          phase: 'cross_exam',
          botMessageCount: 3,
          questionText: 'compare these approaches',
          stanceByParticipantBotOpenId: { ou_a: 'option A' },
          unresponsiveParticipantBotOpenIds: [],
          phaseSummaries: [],
          recentEvents,
          pendingParticipantBotOpenIds: [],
          participantDeadlinesByBotOpenId: {},
          policy: {
            maxBotMessages: 20,
            maxDurationMs: 900000,
          },
        },
      },
      earlyResults: {},
    },
    runReplyQueue: [{
      text: 'Final bounded verdict.',
      media: [],
      raw: 'Final bounded verdict.',
    }],
  });

  await harness.handleInbound(makeInbound({
    text: '[task:disc123] participant update',
    meta: {
      senderType: 'ASSISTANT',
      senderOpenId: 'ou_a',
      mentionOpenIds: [],
      messageId: 'om_participant',
      eventId: 'oe_participant',
    },
  }));

  assert.equal(harness.runReplyCalls.length, 1);
  assert.equal(harness.runReplyCalls[0].inbound.meta.discussion.recentEvents.length, 10);
});
