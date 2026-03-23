import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function sessionFilePath(baseDir, peerId) {
  const safeName = crypto.createHash('sha1').update(peerId).digest('hex');
  return path.join(baseDir, `${safeName}.json`);
}

export async function ensureSessionStore(baseDir) {
  await fs.mkdir(baseDir, { recursive: true });
}

export async function loadConversation(baseDir, peerId) {
  const filePath = sessionFilePath(baseDir, peerId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function saveConversation(baseDir, peerId, messages) {
  const filePath = sessionFilePath(baseDir, peerId);
  const payload = {
    peerId,
    updatedAt: new Date().toISOString(),
    messages,
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

export function appendConversation(messages, entry, limit) {
  const next = [...messages, entry];
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}
