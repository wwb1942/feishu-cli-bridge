import test from 'node:test';
import assert from 'node:assert/strict';

function buildConfig(overrides = {}) {
  return {
    backend: 'codex',
    sessionsDir: 'D:/test/sessions',
    mediaDir: 'D:/test/media',
    processLockFile: 'D:/test/process.lock',
    inboundStateFile: 'D:/test/inbound-state.json',
    inboundClaimsDir: 'D:/test/inbound-claims',
    feishu: {
      inboundDedupWindowMs: 60_000,
      inboundRepliedTtlMs: 60_000,
      inboundProcessingTtlMs: 60_000,
      groupDelegationEnabled: true,
      botOpenId: '',
      delegateTimeoutMs: 5_000,
      discussionHostBotOpenId: '',
      discussionMaxBotMessages: 20,
      discussionMaxDurationMs: 900_000,
    },
    ...overrides,
  };
}

function buildInbound(overrides = {}) {
  return {
    peerId: 'ou_user',
    text: 'hello',
    attachments: [],
    meta: {
      chatId: 'oc_chat',
      chatType: 'group',
      messageId: 'om_1',
      eventId: 'evt_1',
      senderOpenId: 'ou_user',
      senderType: 'USER',
      mentionOpenIds: ['ou_bot'],
      contentFingerprint: 'fp-1',
    },
    ...overrides,
  };
}

test('startBridgeApp creates runtime after bridge startup and forwards inbound events to it', async () => {
  const { startBridgeApp } = await import('../src/bridge-app.js');
  const savedStates = [];
  const runtimeInbounds = [];
  const createRuntimeCalls = [];
  let inboundHandler;

  await startBridgeApp({
    config: buildConfig(),
    backendConfig: { historyLimit: 12, imageHistoryLimit: 4 },
    runReply: async () => ({ text: 'unused', media: [], raw: 'unused' }),
    startBridge: async (feishuConfig, _mediaDir, onInboundMessage) => {
      feishuConfig.botOpenId = 'ou_resolved_bot';
      inboundHandler = onInboundMessage;
      return {
        sendReply: async () => ({ data: { message_id: 'om_reply_1' } }),
      };
    },
    createRuntime: async deps => {
      createRuntimeCalls.push(deps);
      return {
        handleInbound: async inbound => {
          runtimeInbounds.push(inbound);
          return { route: { kind: 'group_user_request' } };
        },
        sweepTimeouts: async () => [],
        stop: async () => {},
      };
    },
    ensureSessionStore: async () => {},
    acquireProcessLock: async () => async () => {},
    loadInboundState: async () => ({ events: {} }),
    saveInboundState: async (_filePath, state) => {
      savedStates.push(JSON.parse(JSON.stringify(state)));
    },
    claimInboundEvent: async (_claimsDir, eventKey) => ({
      accepted: true,
      filePath: `claim:${eventKey}`,
    }),
    updateInboundEventClaim: async () => {},
    releaseInboundEventClaim: async () => {},
    fsImpl: {
      mkdir: async () => {},
    },
  });

  await inboundHandler(buildInbound());

  assert.equal(createRuntimeCalls.length, 1);
  assert.equal(createRuntimeCalls[0].config.feishu.botOpenId, 'ou_resolved_bot');
  assert.equal(runtimeInbounds.length, 1);
  assert.equal(runtimeInbounds[0].text, 'hello');
  assert.equal(savedStates.at(-1).events['event:evt_1'].status, 'replied');
  assert.equal(savedStates.at(-1).events['message:om_1'].status, 'replied');
});

test('startBridgeApp keeps placeholder media until the next text message for the same peer', async () => {
  const { startBridgeApp } = await import('../src/bridge-app.js');
  const runtimeInbounds = [];
  let inboundHandler;

  await startBridgeApp({
    config: buildConfig(),
    backendConfig: { historyLimit: 12, imageHistoryLimit: 4 },
    runReply: async () => ({ text: 'unused', media: [], raw: 'unused' }),
    startBridge: async (feishuConfig, _mediaDir, onInboundMessage) => {
      feishuConfig.botOpenId = 'ou_resolved_bot';
      inboundHandler = onInboundMessage;
      return {
        sendReply: async () => ({ data: { message_id: 'om_reply_1' } }),
      };
    },
    createRuntime: async () => ({
      handleInbound: async inbound => {
        runtimeInbounds.push(inbound);
        return { route: { kind: 'group_user_request' } };
      },
      sweepTimeouts: async () => [],
      stop: async () => {},
    }),
    ensureSessionStore: async () => {},
    acquireProcessLock: async () => async () => {},
    loadInboundState: async () => ({ events: {} }),
    saveInboundState: async () => {},
    claimInboundEvent: async (_claimsDir, eventKey) => ({
      accepted: true,
      filePath: `claim:${eventKey}`,
    }),
    updateInboundEventClaim: async () => {},
    releaseInboundEventClaim: async () => {},
    fsImpl: {
      mkdir: async () => {},
    },
    mediaMergeWaitMs: 5,
    mediaMergePollMs: 1,
  });

  await inboundHandler(buildInbound({
    text: '[image]',
    attachments: [{ kind: 'image', path: 'D:/tmp/input.png', fileName: 'input.png' }],
    meta: {
      ...buildInbound().meta,
      messageId: 'om_media',
      eventId: 'evt_media',
    },
  }));

  assert.equal(runtimeInbounds.length, 0);

  await inboundHandler(buildInbound({
    text: 'please inspect this image',
    meta: {
      ...buildInbound().meta,
      messageId: 'om_text',
      eventId: 'evt_text',
    },
  }));

  assert.equal(runtimeInbounds.length, 1);
  assert.deepEqual(runtimeInbounds[0].attachments, [{ kind: 'image', path: 'D:/tmp/input.png', fileName: 'input.png' }]);
});

test('startBridgeApp reuses recent media when the follow-up asks about 这张图', async () => {
  const { startBridgeApp } = await import('../src/bridge-app.js');
  const runtimeInbounds = [];
  let inboundHandler;

  await startBridgeApp({
    config: buildConfig(),
    backendConfig: { historyLimit: 12, imageHistoryLimit: 4 },
    runReply: async () => ({ text: 'unused', media: [], raw: 'unused' }),
    startBridge: async (feishuConfig, _mediaDir, onInboundMessage) => {
      feishuConfig.botOpenId = 'ou_resolved_bot';
      inboundHandler = onInboundMessage;
      return {
        sendReply: async () => ({ data: { message_id: 'om_reply_1' } }),
      };
    },
    createRuntime: async () => ({
      handleInbound: async inbound => {
        runtimeInbounds.push(inbound);
        return { route: { kind: 'group_user_request' } };
      },
      sweepTimeouts: async () => [],
      stop: async () => {},
    }),
    ensureSessionStore: async () => {},
    acquireProcessLock: async () => async () => {},
    loadInboundState: async () => ({ events: {} }),
    saveInboundState: async () => {},
    claimInboundEvent: async (_claimsDir, eventKey) => ({
      accepted: true,
      filePath: `claim:${eventKey}`,
    }),
    updateInboundEventClaim: async () => {},
    releaseInboundEventClaim: async () => {},
    fsImpl: {
      mkdir: async () => {},
    },
    mediaMergeWaitMs: 5,
    mediaMergePollMs: 1,
  });

  await inboundHandler(buildInbound({
    text: '[image]',
    attachments: [{ kind: 'image', path: 'D:/tmp/input.png', fileName: 'input.png' }],
    meta: {
      ...buildInbound().meta,
      messageId: 'om_media',
      eventId: 'evt_media',
    },
  }));

  await inboundHandler(buildInbound({
    text: 'please summarize this later',
    meta: {
      ...buildInbound().meta,
      messageId: 'om_text_1',
      eventId: 'evt_text_1',
    },
  }));

  await inboundHandler(buildInbound({
    text: '看这张图',
    meta: {
      ...buildInbound().meta,
      messageId: 'om_text_2',
      eventId: 'evt_text_2',
    },
  }));

  assert.equal(runtimeInbounds.length, 2);
  assert.deepEqual(runtimeInbounds[1].attachments, [{ kind: 'image', path: 'D:/tmp/input.png', fileName: 'input.png' }]);
});
