import * as Lark from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ASSISTANT_DELEGATE_PREFIX_RE = /^\s*\[delegate\]\s*\[task:[a-z0-9_-]+\]\s*/i;
const ASSISTANT_TASK_PREFIX_RE = /^\s*\[task:[a-z0-9_-]+\]\s*/i;

function createLogger(prefix) {
  return {
    debug(message, extra) {
      console.log(`[${prefix}] ${message}`, extra || '');
    },
    info(message, extra) {
      console.log(`[${prefix}] ${message}`, extra || '');
    },
    warn(message, extra) {
      console.warn(`[${prefix}] ${message}`, extra || '');
    },
    error(message, extra) {
      console.error(`[${prefix}] ${message}`, extra || '');
    },
  };
}

function resolveDomain(domain) {
  if (domain === 'lark') {
    return Lark.Domain.Lark;
  }
  return Lark.Domain.Feishu;
}

function getProxyAgent() {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

function createClient(config) {
  return new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(config.domain),
  });
}

function createWsClient(config) {
  const agent = getProxyAgent();
  return new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveDomain(config.domain),
    loggerLevel: Lark.LoggerLevel.info,
    ...(agent ? { agent } : {}),
  });
}

function createDispatcher(config) {
  return new Lark.EventDispatcher({
    encryptKey: config.encryptKey || undefined,
    verificationToken: config.verificationToken || undefined,
  });
}

function parseMessageContent(message) {
  if (!message?.content) {
    return {};
  }
  try {
    return JSON.parse(message.content);
  } catch {
    return {};
  }
}

function normalizeLogger(logger = {}) {
  return {
    debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : (() => {}),
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : (() => {}),
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function assertInboundByteLimit(byteLength, maxBytes) {
  if (Number.isInteger(maxBytes) && maxBytes > 0 && byteLength > maxBytes) {
    throw new Error(`Inbound payload exceeds FEISHU_MAX_INBOUND_BYTES (${byteLength} > ${maxBytes} bytes).`);
  }
}

function getUtf8ByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

export function extractMentionOpenIds(message) {
  return (message?.mentions || [])
    .map((mention) => mention?.id?.open_id || '')
    .filter(Boolean);
}

export function buildReplyTarget(meta = {}) {
  if (meta.chatType === 'group') {
    return {
      receiveIdType: 'chat_id',
      receiveId: meta.chatId,
    };
  }

  return {
    receiveIdType: 'open_id',
    receiveId: meta.senderOpenId,
  };
}

export function shouldForwardAssistantGroupMessage(text = '') {
  return ASSISTANT_DELEGATE_PREFIX_RE.test(text) || ASSISTANT_TASK_PREFIX_RE.test(text);
}

export function serializeTextForFeishu(text = '', mentionOpenIds = []) {
  const ids = unique(mentionOpenIds);
  if (ids.length === 0) {
    return text;
  }

  let serialized = text;
  for (const openId of ids.sort((left, right) => right.length - left.length)) {
    serialized = serialized.replace(
      new RegExp(`@${escapeRegExp(openId)}(?![A-Za-z0-9_-])`, 'g'),
      `<at user_id="${openId}"></at>`,
    );
  }
  return serialized;
}

function firstNonEmpty(values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function extractBotOpenIdFromResponse(response) {
  return firstNonEmpty([
    response?.open_id,
    response?.bot_open_id,
    response?.data?.open_id,
    response?.data?.bot_open_id,
    response?.data?.app?.open_id,
    response?.data?.app?.bot_open_id,
    response?.data?.app?.bot?.open_id,
    response?.data?.bot?.open_id,
  ]);
}

export async function resolveBotIdentity(client, config = {}, logger = {}) {
  const log = normalizeLogger(logger);
  const configuredBotOpenId = typeof config.botOpenId === 'string' ? config.botOpenId.trim() : '';
  if (configuredBotOpenId) {
    log.debug('Using configured FEISHU_BOT_OPEN_ID.');
    return configuredBotOpenId;
  }

  const resolvers = [
    {
      name: 'bot.v3.info.get',
      run: async () => client?.bot?.v3?.info?.get?.(),
    },
    {
      name: 'application.v6.application.get',
      run: async () => client?.application?.v6?.application?.get?.({ path: { app_id: config.appId } }),
    },
  ];

  for (const resolver of resolvers) {
    try {
      log.debug(`Attempting bot identity resolver ${resolver.name}.`);
      const response = await resolver.run();
      const botOpenId = extractBotOpenIdFromResponse(response);
      if (botOpenId) {
        log.debug(`Resolved bot identity via ${resolver.name}.`);
        return botOpenId;
      }
      log.debug(`Bot identity resolver ${resolver.name} returned no open id.`);
    } catch (error) {
      log.warn(`Bot identity resolver ${resolver.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log.warn('Unable to resolve bot identity from configured Feishu resolvers.');
  return '';
}

function splitText(text, chunkChars) {
  if (text.length <= chunkChars) {
    return [text];
  }
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + chunkChars));
    cursor += chunkChars;
  }
  return chunks;
}

async function readFeishuResponseBuffer(response, maxBytes = Number.POSITIVE_INFINITY) {
  const responseAny = response;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(responseAny.msg || `code ${responseAny.code}`);
  }

  if (Buffer.isBuffer(response)) {
    assertInboundByteLimit(response.length, maxBytes);
    return response;
  }
  if (response instanceof ArrayBuffer) {
    const buffer = Buffer.from(response);
    assertInboundByteLimit(buffer.length, maxBytes);
    return buffer;
  }
  if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    assertInboundByteLimit(responseAny.data.length, maxBytes);
    return responseAny.data;
  }
  if (typeof responseAny.getReadableStream === 'function') {
    const stream = responseAny.getReadableStream();
    const chunks = [];
    let totalLength = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalLength += buffer.length;
      assertInboundByteLimit(totalLength, maxBytes);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  if (typeof responseAny.writeFile === 'function') {
    const tempPath = path.join(os.tmpdir(), `feishu-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
    await responseAny.writeFile(tempPath);
    const buffer = await fs.readFile(tempPath);
    assertInboundByteLimit(buffer.length, maxBytes);
    await fs.unlink(tempPath).catch(() => {});
    return buffer;
  }
  throw new Error('Unsupported Feishu media response format');
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function sanitizeFileName(fileName, fallback) {
  const base = (fileName || fallback || 'file.bin').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim();
  return base || fallback || 'file.bin';
}

async function saveAttachment(buffer, outputDir, fileName) {
  await ensureDir(outputDir);
  const filePath = path.join(outputDir, fileName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function downloadInboundAttachment(client, message, config, mediaDir) {
  const content = parseMessageContent(message);
  const messageId = message.message_id;
  const messageType = message.message_type;
  const attachmentDir = path.join(mediaDir, 'inbound', messageId || 'unknown');

  if (messageType === 'image') {
    const imageKey = content.image_key;
    if (!imageKey) {
      return null;
    }
    const response = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    });
    const buffer = await readFeishuResponseBuffer(response, config.maxInboundBytes);
    const fileName = sanitizeFileName(content.file_name, `${messageId || 'image'}.png`);
    const filePath = await saveAttachment(buffer, attachmentDir, fileName);
    return { kind: 'image', path: filePath, fileName };
  }

  if (messageType === 'file' || messageType === 'media' || messageType === 'audio') {
    const fileKey = content.file_key;
    if (!fileKey) {
      return null;
    }
    const resourceType = messageType === 'image' ? 'image' : 'file';
    const response = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: resourceType },
    });
    const buffer = await readFeishuResponseBuffer(response, config.maxInboundBytes);
    const fallbackName = messageType === 'audio' ? `${messageId || 'audio'}.opus` : `${messageId || 'file'}.bin`;
    const fileName = sanitizeFileName(content.file_name, fallbackName);
    const filePath = await saveAttachment(buffer, attachmentDir, fileName);
    return { kind: 'file', path: filePath, fileName };
  }

  return null;
}

async function uploadImage(client, imagePath) {
  const response = await client.im.image.create({
    data: {
      image_type: 'message',
      image: path.isAbsolute(imagePath) ? await fs.readFile(imagePath) : await fs.readFile(path.resolve(imagePath)),
    },
  });
  const responseAny = response;
  const imageKey = responseAny.image_key ?? responseAny.data?.image_key;
  if (!imageKey) {
    throw new Error('Feishu image upload failed: no image_key returned');
  }
  return imageKey;
}

function detectFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.opus':
    case '.ogg':
      return 'opus';
    case '.mp4':
    case '.mov':
      return 'mp4';
    case '.pdf':
      return 'pdf';
    case '.doc':
    case '.docx':
      return 'doc';
    case '.xls':
    case '.xlsx':
      return 'xls';
    case '.ppt':
    case '.pptx':
      return 'ppt';
    default:
      return 'stream';
  }
}

async function uploadFile(client, filePath) {
  const fileName = path.basename(filePath);
  const response = await client.im.file.create({
    data: {
      file_type: detectFileType(fileName),
      file_name: fileName,
      file: path.isAbsolute(filePath) ? await fs.readFile(filePath) : await fs.readFile(path.resolve(filePath)),
    },
  });
  const responseAny = response;
  const fileKey = responseAny.file_key ?? responseAny.data?.file_key;
  if (!fileKey) {
    throw new Error('Feishu file upload failed: no file_key returned');
  }
  return fileKey;
}

function parseReplyMedia(reply) {
  return (reply.media || []).filter((item) => item?.path);
}

function parseInboundText(message) {
  const content = parseMessageContent(message);
  return typeof content.text === 'string' ? content.text.trim() : '';
}

function buildContentFingerprint(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  const digest = crypto.createHash('sha1').update(`${message?.message_type || ''}\n${content}`).digest('hex');
  return digest;
}

function createRecentOutboundTracker(ttlMs = 10 * 60 * 1000) {
  const sentMessageIds = new Map();

  function prune(now = Date.now()) {
    for (const [messageId, expiresAt] of sentMessageIds.entries()) {
      if (expiresAt <= now) {
        sentMessageIds.delete(messageId);
      }
    }
  }

  return {
    remember(messageId) {
      if (!messageId) {
        return;
      }
      const now = Date.now();
      prune(now);
      sentMessageIds.set(messageId, now + ttlMs);
    },
    has(messageId) {
      if (!messageId) {
        return false;
      }
      prune();
      return sentMessageIds.has(messageId);
    },
  };
}

function buildOutboundUuid(replyMeta, kind, index) {
  const seed = [
    replyMeta?.messageId || 'standalone',
    kind,
    String(index),
  ].join(':');
  return crypto.createHash('sha1').update(seed).digest('hex');
}

function getCreatedMessageId(response) {
  return response?.data?.message_id || response?.message_id || '';
}

async function createMessage(client, tracker, payload) {
  const response = await client.im.message.create(payload);
  tracker.remember(getCreatedMessageId(response));
  return response;
}

export async function startFeishuBridge(config, mediaDir, onInboundMessage) {
  const log = createLogger('feishu-bridge');
  const client = createClient(config);
  const resolvedBotOpenId = await resolveBotIdentity(client, config, log);
  if (resolvedBotOpenId) {
    config.botOpenId = resolvedBotOpenId;
  }
  if (config.groupDelegationEnabled && !config.botOpenId) {
    throw new Error('Failed to resolve FEISHU_BOT_OPEN_ID for group delegation');
  }
  const wsClient = createWsClient(config);
  const dispatcher = createDispatcher(config);
  const recentOutbound = createRecentOutboundTracker();

  function dispatchInbound(inbound) {
    Promise.resolve()
      .then(() => onInboundMessage(inbound))
      .catch((error) => {
        log.error(`inbound handler failed for message=${inbound.meta?.messageId || '-'} event=${inbound.meta?.eventId || '-'}`, error);
      });
  }

  dispatcher.register({
    'im.message.receive_v1': async (data) => {
      const event = data;
      const eventId = event?.header?.event_id || event?.event_id || '';
      const message = event?.message;
      if (!message) {
        return;
      }
      if (recentOutbound.has(message.message_id)) {
        log.info(`ignored outbound echo by message id for ${message.message_id}`);
        return;
      }
      if (getUtf8ByteLength(message.content) > config.maxInboundBytes) {
        log.warn(`ignored inbound message ${message.message_id || '-'} because content exceeds FEISHU_MAX_INBOUND_BYTES`);
        return;
      }
      const text = parseInboundText(message);
      const senderType = event?.sender?.sender_type || '';
      if (senderType === 'ASSISTANT' && (
        !config.groupDelegationEnabled
        || !shouldForwardAssistantGroupMessage(text)
      )) {
        log.info(`ignored assistant echo for ${message.message_id}`);
        return;
      }
      const chatId = message.chat_id;
      const messageId = message.message_id;
      const chatType = message.chat_type;
      const senderOpenId = event?.sender?.sender_id?.open_id || '';
      const mentionOpenIds = extractMentionOpenIds(message);
      Promise.resolve()
        .then(async () => {
          const attachment = await downloadInboundAttachment(client, message, config, mediaDir).catch((error) => {
            log.warn(`attachment download failed for ${messageId}: ${error.message}`);
            return null;
          });

          if (!text && !attachment) {
            return;
          }

          dispatchInbound({
            peerId: senderOpenId || chatId,
            text: text || `[${message.message_type || 'message'}]`,
            attachments: attachment ? [attachment] : [],
            meta: {
              chatId,
              messageId,
              eventId,
              chatType,
              contentFingerprint: buildContentFingerprint(message),
              senderOpenId,
              senderType,
              mentionOpenIds,
            },
          });
        })
        .catch((error) => {
          log.error(`inbound preload failed for message=${messageId || '-'} event=${eventId || '-'}`, error);
        });
    },
    'im.message.message_read_v1': async () => {},
  });

  wsClient.start({
    eventDispatcher: dispatcher,
  });

  log.info('WebSocket client started');

  return {
    async sendReply(target, reply, replyMeta) {
      const replyTarget = typeof target === 'string'
        ? { receiveIdType: 'open_id', receiveId: target }
        : target;
      const textChunks = splitText(
        serializeTextForFeishu(reply.text || '', replyMeta?.mentionOpenIds || []),
        config.chunkChars,
      ).filter(Boolean);
      for (const [index, chunk] of textChunks.entries()) {
        await createMessage(client, recentOutbound, {
          params: { receive_id_type: replyTarget.receiveIdType },
          data: {
            receive_id: replyTarget.receiveId,
            content: JSON.stringify({ text: chunk }),
            msg_type: 'text',
            uuid: buildOutboundUuid(replyMeta, 'text', index),
          },
        });
      }

      for (const [index, media] of parseReplyMedia(reply).entries()) {
        if (media.kind === 'image') {
          const imageKey = await uploadImage(client, media.path);
          const payload = { content: JSON.stringify({ image_key: imageKey }), msg_type: 'image' };
          await createMessage(client, recentOutbound, {
            params: { receive_id_type: replyTarget.receiveIdType },
            data: { receive_id: replyTarget.receiveId, ...payload, uuid: buildOutboundUuid(replyMeta, 'image', index) },
          });
          continue;
        }

        const fileKey = await uploadFile(client, media.path);
        const payload = { content: JSON.stringify({ file_key: fileKey }), msg_type: 'file' };
        await createMessage(client, recentOutbound, {
          params: { receive_id_type: replyTarget.receiveIdType },
          data: { receive_id: replyTarget.receiveId, ...payload, uuid: buildOutboundUuid(replyMeta, 'file', index) },
        });
      }
    },
  };
}
