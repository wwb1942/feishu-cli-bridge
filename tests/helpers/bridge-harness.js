import { appendConversation } from '../../src/session-store.js';
import { createBridgeRuntime } from '../../src/bridge-runtime.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildConfig(overrides = {}) {
  return {
    backend: 'codex',
    sessionsDir: 'D:/test/sessions',
    pendingTasksFile: 'D:/test/pending-tasks.json',
    feishu: {
      appId: 'cli_test',
      appSecret: 'secret',
      groupDelegationEnabled: true,
      botOpenId: 'ou_bot',
      delegateTimeoutMs: 5_000,
      discussionHostBotOpenId: '',
      discussionMaxBotMessages: 20,
      discussionMaxDurationMs: 900_000,
    },
    ...overrides,
  };
}

function buildBackendConfig(overrides = {}) {
  return {
    historyLimit: 12,
    imageHistoryLimit: 4,
    systemPrompt: 'SYSTEM',
    ...overrides,
  };
}

export async function createBridgeHarness(options = {}) {
  let now = options.now ?? 10_000;
  const sentReplies = [];
  const runReplyCalls = [];
  const histories = new Map();
  const pendingState = clone(options.pendingState || { tasks: {}, earlyResults: {} });
  const sendFailures = [...(options.sendFailures || [])];
  const runReplyQueue = [...(options.runReplyQueue || [])];

  const runtime = await createBridgeRuntime({
    config: buildConfig(options.config),
    backendConfig: buildBackendConfig(options.backendConfig),
    runReply: async (backendConfig, history, inbound) => {
      runReplyCalls.push({ backendConfig, history, inbound });
      const next = runReplyQueue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next || { text: 'ok', media: [], raw: 'ok' };
    },
    bridge: {
      sendReply: async (target, reply, replyMeta) => {
        const failure = sendFailures.shift();
        if (failure) {
          throw failure;
        }
        sentReplies.push({ target, reply, replyMeta });
        return { data: { message_id: `msg_${sentReplies.length}` } };
      },
    },
    loadConversation: async (_baseDir, sessionKey) => histories.get(sessionKey) || [],
    saveConversation: async (_baseDir, sessionKey, messages) => {
      histories.set(sessionKey, messages);
    },
    appendConversation,
    loadPendingTasks: async () => pendingState,
    savePendingTasks: async (_filePath, state) => {
      pendingState.tasks = clone(state.tasks || {});
      pendingState.earlyResults = clone(state.earlyResults || {});
    },
    now: () => now,
    setIntervalImpl: (fn, interval) => ({
      fn,
      interval,
      unref() {},
    }),
    clearIntervalImpl() {},
  });

  return {
    runtime,
    sentReplies,
    runReplyCalls,
    histories,
    pendingState,
    setNow(value) {
      now = value;
    },
    advanceTime(ms) {
      now += ms;
    },
    async handleInbound(inbound) {
      return runtime.handleInbound(inbound);
    },
    async sweep() {
      return runtime.sweepTimeouts();
    },
  };
}
