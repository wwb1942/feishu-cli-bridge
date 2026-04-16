import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeHarness } from './helpers/bridge-harness.js';

function makeInbound(overrides = {}) {
  const { meta: metaOverrides = {}, ...restOverrides } = overrides;
  const meta = {
    chatType: 'p2p',
    chatId: 'oc_chat',
    senderOpenId: 'ou_user',
    senderType: 'USER',
    mentionOpenIds: [],
    messageId: 'om_1',
    eventId: 'oe_1',
    ...metaOverrides,
  };

  return {
    peerId: meta.senderOpenId,
    text: 'hello',
    attachments: [],
    meta,
    ...restOverrides,
  };
}

test('group human request runs model execution and replies to chat_id with a group session key', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [{ text: 'group answer', media: [], raw: 'group answer' }],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot summarize this',
    meta: {
      chatType: 'group',
      mentionOpenIds: ['ou_bot'],
    },
  }));

  assert.equal(harness.runReplyCalls.length, 1);
  assert.equal(harness.runReplyCalls[0].inbound.meta.sessionKey, 'group:oc_chat:user:ou_user:bot:ou_bot');
  assert.deepEqual(harness.sentReplies[0].target, {
    receiveIdType: 'chat_id',
    receiveId: 'oc_chat',
  });
});

test('assistant delegate request runs model execution in a delegated-task session and replies to chat_id', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [{ text: '[task:abc123] done', media: [], raw: '[task:abc123] done' }],
  });

  await harness.handleInbound(makeInbound({
    text: '[delegate] [task:abc123] @bot do the work',
    meta: {
      chatType: 'group',
      senderType: 'ASSISTANT',
      mentionOpenIds: ['ou_bot'],
      senderOpenId: 'ou_origin_bot',
    },
  }));

  assert.equal(harness.runReplyCalls.length, 1);
  assert.equal(harness.runReplyCalls[0].inbound.meta.sessionKey, 'group:oc_chat:task:abc123:bot:ou_bot');
  assert.deepEqual(harness.sentReplies[0].target, {
    receiveIdType: 'chat_id',
    receiveId: 'oc_chat',
  });
});

test('assistant task result reconciles pending state and does not run model execution', async () => {
  const harness = await createBridgeHarness({
    pendingState: {
      tasks: {
        abc123: {
          taskId: 'abc123',
          kind: 'delegation',
          status: 'pending',
          deadlineAt: 20_000,
          chatId: 'oc_chat',
        },
      },
      earlyResults: {},
    },
  });

  await harness.handleInbound(makeInbound({
    text: '[task:abc123] delegated result',
    meta: {
      chatType: 'group',
      senderType: 'ASSISTANT',
      senderOpenId: 'ou_delegate_bot',
    },
  }));

  assert.equal(harness.runReplyCalls.length, 0);
  assert.equal(harness.pendingState.tasks.abc123.status, 'completed');
  assert.equal(harness.sentReplies.length, 0);
});

test('origin bot sends delegation, creates pending task, and posts confirmation only on success', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [{
      text: '[delegate] [task:abc123] @ou_bot_b investigate this',
      media: [],
      raw: '[delegate] [task:abc123] @ou_bot_b investigate this',
    }],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot handle this',
    meta: {
      chatType: 'group',
      mentionOpenIds: ['ou_bot'],
    },
  }));

  assert.equal(harness.pendingState.tasks.abc123.status, 'pending');
  assert.equal(harness.sentReplies.length, 2);
  assert.match(harness.sentReplies[0].reply.text, /^\[delegate\] \[task:abc123\]/);
  assert.deepEqual(harness.sentReplies[0].replyMeta.mentionOpenIds, ['ou_bot_b']);
  assert.match(harness.sentReplies[1].reply.text, /Delegated/i);
});

test('origin bot posts a send-failure exception when delegation send fails', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [{
      text: '[delegate] [task:abc123] @ou_bot_b investigate this',
      media: [],
      raw: '[delegate] [task:abc123] @ou_bot_b investigate this',
    }],
    sendFailures: [new Error('delegate send failed')],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot handle this',
    meta: {
      chatType: 'group',
      mentionOpenIds: ['ou_bot'],
    },
  }));

  assert.equal(harness.sentReplies.length, 1);
  assert.match(harness.sentReplies[0].reply.text, /failed|unable/i);
});

test('delegation wait-timeout posts a timeout notice to the same group', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [{
      text: '[delegate] [task:abc123] @ou_bot_b investigate this',
      media: [],
      raw: '[delegate] [task:abc123] @ou_bot_b investigate this',
    }],
  });

  await harness.handleInbound(makeInbound({
    text: '@bot handle this',
    meta: {
      chatType: 'group',
      mentionOpenIds: ['ou_bot'],
    },
  }));

  harness.advanceTime(6_000);
  await harness.sweep();

  assert.equal(harness.pendingState.tasks.abc123.status, 'timed_out');
  assert.match(harness.sentReplies.at(-1).reply.text, /timeout|timed out/i);
  assert.deepEqual(harness.sentReplies.at(-1).target, {
    receiveIdType: 'chat_id',
    receiveId: 'oc_chat',
  });
});

test('delegated bot posts failure in group when its own runner errors', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [new Error('runner timed out after 5000ms')],
  });

  await harness.handleInbound(makeInbound({
    text: '[delegate] [task:abc123] @bot do the work',
    meta: {
      chatType: 'group',
      senderType: 'ASSISTANT',
      mentionOpenIds: ['ou_bot'],
      senderOpenId: 'ou_origin_bot',
    },
  }));

  assert.equal(harness.sentReplies.length, 1);
  assert.deepEqual(harness.sentReplies[0].target, {
    receiveIdType: 'chat_id',
    receiveId: 'oc_chat',
  });
  assert.match(harness.sentReplies[0].reply.text, /timed out|failed/i);
});

test('direct-message flow still replies to open_id', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [{ text: 'dm answer', media: [], raw: 'dm answer' }],
  });

  await harness.handleInbound(makeInbound({
    text: 'hello in dm',
    meta: {
      chatType: 'p2p',
      mentionOpenIds: [],
    },
  }));

  assert.equal(harness.runReplyCalls.length, 1);
  assert.equal(harness.runReplyCalls[0].inbound.meta.sessionKey, 'dm:ou_user');
  assert.deepEqual(harness.sentReplies[0].target, {
    receiveIdType: 'open_id',
    receiveId: 'ou_user',
  });
});

test('out-of-order delegated result is buffered and reconciled when the pending task appears later', async () => {
  const harness = await createBridgeHarness({
    runReplyQueue: [{
      text: '[delegate] [task:abc123] @ou_bot_b investigate this',
      media: [],
      raw: '[delegate] [task:abc123] @ou_bot_b investigate this',
    }],
  });

  await harness.handleInbound(makeInbound({
    text: '[task:abc123] delegated result arrived early',
    meta: {
      chatType: 'group',
      senderType: 'ASSISTANT',
      senderOpenId: 'ou_delegate_bot',
      mentionOpenIds: [],
      messageId: 'om_early',
      eventId: 'oe_early',
    },
  }));

  assert.equal(harness.runReplyCalls.length, 0);
  assert.equal(harness.pendingState.earlyResults.abc123?.taskId, 'abc123');

  await harness.handleInbound(makeInbound({
    text: '@bot handle this',
    meta: {
      chatType: 'group',
      mentionOpenIds: ['ou_bot'],
      messageId: 'om_request',
      eventId: 'oe_request',
    },
  }));

  assert.equal(harness.pendingState.tasks.abc123.status, 'completed');
  assert.equal(harness.pendingState.earlyResults.abc123, undefined);
});
