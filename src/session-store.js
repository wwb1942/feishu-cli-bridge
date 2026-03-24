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

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

function inboundClaimFilePath(baseDir, eventKey) {
  const safeName = crypto.createHash('sha1').update(eventKey).digest('hex');
  return path.join(baseDir, `${safeName}.json`);
}

function isAlivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readProcessStartTicks(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen === -1) {
      return null;
    }
    const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
    return fields[19] || null;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function loadInboundState(filePath) {
  const payload = await readJsonFile(filePath, { events: {} });
  if (!payload || typeof payload !== 'object' || !payload.events || typeof payload.events !== 'object') {
    return { events: {} };
  }
  return payload;
}

export async function saveInboundState(filePath, state) {
  await writeJsonFile(filePath, {
    updatedAt: new Date().toISOString(),
    events: state.events || {},
  });
}

export async function acquireProcessLock(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const processStartTicks = await readProcessStartTicks(process.pid);
  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    processStartTicks,
  };

  try {
    const handle = await fs.open(filePath, 'wx');
    await handle.writeFile(JSON.stringify(payload, null, 2));
    return async () => {
      await handle.close().catch(() => {});
      await fs.unlink(filePath).catch(() => {});
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = await readJsonFile(filePath, null).catch(() => null);
  const existingPid = Number(existing?.pid);
  if (isAlivePid(existingPid)) {
    const existingProcessStartTicks = existing?.processStartTicks || null;
    const liveProcessStartTicks = await readProcessStartTicks(existingPid);
    const sameProcess = existingProcessStartTicks && liveProcessStartTicks && existingProcessStartTicks === liveProcessStartTicks;
    const legacySelfCollision = !existingProcessStartTicks && existingPid === process.pid;
    if (sameProcess && !legacySelfCollision) {
      throw new Error(`Bridge already running with pid ${existingPid}`);
    }
  }

  await fs.unlink(filePath).catch(() => {});
  const handle = await fs.open(filePath, 'wx');
  await handle.writeFile(JSON.stringify(payload, null, 2));
  return async () => {
    await handle.close().catch(() => {});
    await fs.unlink(filePath).catch(() => {});
  };
}

export async function claimInboundEvent(baseDir, eventKey, payload, ttlMs) {
  await fs.mkdir(baseDir, { recursive: true });
  const filePath = inboundClaimFilePath(baseDir, eventKey);
  const now = Date.now();
  const serialized = JSON.stringify({
    ...payload,
    status: 'processing',
    updatedAt: now,
  }, null, 2);

  try {
    const handle = await fs.open(filePath, 'wx');
    await handle.writeFile(serialized);
    await handle.close();
    return { accepted: true, filePath };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = await readJsonFile(filePath, null).catch(() => null);
  const updatedAt = Number(existing?.updatedAt) || 0;
  if (now - updatedAt < ttlMs) {
    return {
      accepted: false,
      filePath,
      existing,
      reason: existing?.status === 'replied' ? 'already-replied' : 'already-processing',
    };
  }

  await fs.unlink(filePath).catch(() => {});
  return claimInboundEvent(baseDir, eventKey, payload, ttlMs);
}

export async function updateInboundEventClaim(filePath, patch) {
  const current = await readJsonFile(filePath, {});
  await writeJsonFile(filePath, {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  });
}

export async function releaseInboundEventClaim(filePath) {
  await fs.unlink(filePath).catch((error) => {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  });
}
