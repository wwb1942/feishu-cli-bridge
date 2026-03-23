import { loadConfig } from './config.js';
import { ensureSessionStore, loadConversation, saveConversation, appendConversation } from './session-store.js';
import { runCodexReply } from './codex-runner.js';
import { startFeishuBridge } from './feishu-adapter.js';

const config = loadConfig();
await ensureSessionStore(config.sessionsDir);

const queues = new Map();

function enqueue(peerId, task) {
  const previous = queues.get(peerId) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(peerId, next.catch(() => {}));
  return next;
}

const bridge = await startFeishuBridge(config.feishu, async (inbound) => {
  console.log(`[bridge] inbound from ${inbound.peerId}: ${inbound.text}`);
  await enqueue(inbound.peerId, async () => {
    const history = await loadConversation(config.sessionsDir, inbound.peerId);
    const trimmedHistory = history.slice(-config.codex.historyLimit);
    const reply = await runCodexReply(config.codex, trimmedHistory, inbound.text);

    const updated = appendConversation(trimmedHistory, { role: 'user', text: inbound.text, timestamp: Date.now() }, config.codex.historyLimit * 2);
    const finalHistory = appendConversation(updated, { role: 'assistant', text: reply, timestamp: Date.now() }, config.codex.historyLimit * 2);
    await saveConversation(config.sessionsDir, inbound.peerId, finalHistory);

    await bridge.sendText(inbound.meta.senderOpenId || inbound.peerId, reply, {
      messageId: inbound.meta.messageId,
    });
    console.log(`[bridge] replied to ${inbound.peerId}`);
  });
});

console.log('[bridge] feishu-codex-bridge started');
console.log(`[bridge] codex model: ${config.codex.model}`);
console.log(`[bridge] sessions dir: ${config.sessionsDir}`);
