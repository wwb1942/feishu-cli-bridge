import { loadConfig } from './config.js';
import { ensureSessionStore, loadConversation, saveConversation, appendConversation } from './session-store.js';
import { runCodexReply } from './codex-runner.js';
import { startFeishuBridge } from './feishu-adapter.js';
import fs from 'node:fs/promises';

const config = loadConfig();
await ensureSessionStore(config.sessionsDir);
await fs.mkdir(config.mediaDir, { recursive: true });

const queues = new Map();

function enqueue(peerId, task) {
  const previous = queues.get(peerId) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(peerId, next.catch(() => {}));
  return next;
}

function summarizeAttachments(attachments) {
  if (!attachments?.length) {
    return '';
  }
  return attachments.map((attachment) => `[${attachment.kind}] ${attachment.path}`).join('\n');
}

const bridge = await startFeishuBridge(config.feishu, config.mediaDir, async (inbound) => {
  console.log(`[bridge] inbound from ${inbound.peerId}: ${inbound.text}`);
  await enqueue(inbound.peerId, async () => {
    const history = await loadConversation(config.sessionsDir, inbound.peerId);
    const trimmedHistory = history.slice(-config.codex.historyLimit);
    const reply = await runCodexReply(config.codex, trimmedHistory, inbound);

    const userText = [inbound.text, summarizeAttachments(inbound.attachments)].filter(Boolean).join('\n');
    const updated = appendConversation(trimmedHistory, { role: 'user', text: userText, timestamp: Date.now() }, config.codex.historyLimit * 2);
    const assistantText = [reply.text, ...(reply.media || []).map((item) => `[[${item.kind}:${item.path}]]`)].filter(Boolean).join('\n');
    const finalHistory = appendConversation(updated, { role: 'assistant', text: assistantText, timestamp: Date.now() }, config.codex.historyLimit * 2);
    await saveConversation(config.sessionsDir, inbound.peerId, finalHistory);

    await bridge.sendReply(inbound.meta.senderOpenId || inbound.peerId, reply, {
      messageId: inbound.meta.messageId,
    });
    console.log(`[bridge] replied to ${inbound.peerId}`);
  });
});

console.log('[bridge] feishu-codex-bridge started');
console.log(`[bridge] codex model: ${config.codex.model}`);
console.log(`[bridge] sessions dir: ${config.sessionsDir}`);
console.log(`[bridge] media dir: ${config.mediaDir}`);
