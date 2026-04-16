import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTaskId,
  extractLeadingTaskId,
  isDelegateMessage,
  selectDiscussionHostBotOpenId,
  classifyInboundMessage,
  buildSessionKey,
  generateTaskId,
} from '../src/group-routing.js';

test('extractTaskId only returns a leading task marker', () => {
  assert.equal(extractTaskId('[task:abc123] finished'), 'abc123');
  assert.equal(extractTaskId('prefix [task:abc123] finished'), '');
  assert.equal(extractLeadingTaskId('  [task:abc123] finished'), 'abc123');
});

test('isDelegateMessage accepts delegate prefix with flexible spacing', () => {
  assert.equal(isDelegateMessage('[delegate] [task:abc123] @bot handle this'), true);
  assert.equal(isDelegateMessage('  [delegate][task:abc123] @bot handle this'), true);
  assert.equal(isDelegateMessage('[delegate]   [task:abc123] @bot handle this'), true);
  assert.equal(isDelegateMessage('[delegate] later [task:abc123] @bot handle this'), false);
});

test('selectDiscussionHostBotOpenId prefers configured host when it is mentioned', () => {
  const host = selectDiscussionHostBotOpenId({
    mentionOpenIds: ['ou_bot_b', 'ou_bot_a'],
    discussionHostBotOpenId: 'ou_bot_a',
    mentionOrderReliable: true,
  });

  assert.equal(host, 'ou_bot_a');
});

test('selectDiscussionHostBotOpenId falls back to mention order when configured host is absent', () => {
  const host = selectDiscussionHostBotOpenId({
    mentionOpenIds: ['ou_bot_b', 'ou_bot_a'],
    discussionHostBotOpenId: 'ou_bot_c',
    mentionOrderReliable: true,
  });

  assert.equal(host, 'ou_bot_b');
});

test('selectDiscussionHostBotOpenId falls back to lexicographic order when mention order is unreliable', () => {
  const host = selectDiscussionHostBotOpenId({
    mentionOpenIds: ['ou_bot_c', 'ou_bot_a', 'ou_bot_b'],
    mentionOrderReliable: false,
  });

  assert.equal(host, 'ou_bot_a');
});

test('classifyInboundMessage returns group_user_request for a single mentioned human request', () => {
  const route = classifyInboundMessage({
    chatType: 'group',
    senderType: 'USER',
    text: '@bot summarize this',
    mentionOpenIds: ['ou_bot_a'],
    selfBotOpenId: 'ou_bot_a',
    mentionOrderReliable: true,
    discussionHostBotOpenId: '',
    pendingTask: null,
  });

  assert.deepEqual(route, {
    kind: 'group_user_request',
    taskId: '',
    hostBotOpenId: '',
  });
});

test('classifyInboundMessage returns group_discussion_request for the elected host', () => {
  const route = classifyInboundMessage({
    chatType: 'group',
    senderType: 'USER',
    text: '@bot-a @bot-b compare approaches',
    mentionOpenIds: ['ou_bot_a', 'ou_bot_b'],
    selfBotOpenId: 'ou_bot_a',
    mentionOrderReliable: true,
    discussionHostBotOpenId: '',
    pendingTask: null,
  });

  assert.deepEqual(route, {
    kind: 'group_discussion_request',
    taskId: '',
    hostBotOpenId: 'ou_bot_a',
  });
});

test('classifyInboundMessage ignores non-host mentioned participants on the original discussion prompt', () => {
  const route = classifyInboundMessage({
    chatType: 'group',
    senderType: 'USER',
    text: '@bot-a @bot-b compare approaches',
    mentionOpenIds: ['ou_bot_a', 'ou_bot_b'],
    selfBotOpenId: 'ou_bot_b',
    mentionOrderReliable: true,
    discussionHostBotOpenId: '',
    pendingTask: null,
  });

  assert.deepEqual(route, {
    kind: 'ignore',
    taskId: '',
    hostBotOpenId: 'ou_bot_a',
  });
});

test('classifyInboundMessage returns group_delegate_request for assistant delegation', () => {
  const route = classifyInboundMessage({
    chatType: 'group',
    senderType: 'ASSISTANT',
    text: ' [delegate] [task:abc123] @bot-b handle this',
    mentionOpenIds: ['ou_bot_b'],
    selfBotOpenId: 'ou_bot_b',
    mentionOrderReliable: true,
    discussionHostBotOpenId: '',
    pendingTask: null,
  });

  assert.deepEqual(route, {
    kind: 'group_delegate_request',
    taskId: 'abc123',
    hostBotOpenId: '',
  });
});

test('classifyInboundMessage returns group_delegate_result only for leading assistant task results with tracked tasks', () => {
  const route = classifyInboundMessage({
    chatType: 'group',
    senderType: 'ASSISTANT',
    text: '[task:abc123] done',
    mentionOpenIds: [],
    selfBotOpenId: 'ou_bot_b',
    mentionOrderReliable: true,
    discussionHostBotOpenId: '',
    pendingTask: { taskId: 'abc123' },
  });

  assert.deepEqual(route, {
    kind: 'group_delegate_result',
    taskId: 'abc123',
    hostBotOpenId: '',
  });
});

test('classifyInboundMessage ignores unrelated task markers and human task marker text', () => {
  const assistantRoute = classifyInboundMessage({
    chatType: 'group',
    senderType: 'ASSISTANT',
    text: 'done [task:abc123]',
    mentionOpenIds: [],
    selfBotOpenId: 'ou_bot_b',
    mentionOrderReliable: true,
    discussionHostBotOpenId: '',
    pendingTask: { taskId: 'abc123' },
  });
  const humanRoute = classifyInboundMessage({
    chatType: 'group',
    senderType: 'USER',
    text: 'I wrote [task:abc123] in plain text',
    mentionOpenIds: ['ou_bot_b'],
    selfBotOpenId: 'ou_bot_b',
    mentionOrderReliable: true,
    discussionHostBotOpenId: '',
    pendingTask: null,
  });

  assert.equal(assistantRoute.kind, 'ignore');
  assert.equal(humanRoute.kind, 'group_user_request');
});

test('buildSessionKey isolates delegated and hosted discussion sessions', () => {
  assert.equal(
    buildSessionKey({
      kind: 'group_delegate_request',
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      selfBotOpenId: 'ou_bot',
      taskId: 'abc123',
    }),
    'group:oc_chat:task:abc123:bot:ou_bot',
  );

  assert.equal(
    buildSessionKey({
      kind: 'group_discussion_request',
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      selfBotOpenId: 'ou_bot',
      taskId: 'disc123',
    }),
    'group:oc_chat:discussion:disc123:host:ou_bot',
  );
});

test('generateTaskId returns a lowercase 8-character id', () => {
  const taskId = generateTaskId();
  assert.match(taskId, /^[a-z0-9]{8}$/);
});
