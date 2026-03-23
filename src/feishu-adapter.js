import * as Lark from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'node:fs/promises';
import path from 'node:path';

function createLogger(prefix) {
  return {
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

async function readFeishuResponseBuffer(response) {
  const responseAny = response;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(responseAny.msg || `code ${responseAny.code}`);
  }

  if (Buffer.isBuffer(response)) {
    return response;
  }
  if (response instanceof ArrayBuffer) {
    return Buffer.from(response);
  }
  if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    return responseAny.data;
  }
  if (typeof responseAny.getReadableStream === 'function') {
    const stream = responseAny.getReadableStream();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof responseAny.writeFile === 'function') {
    const tempPath = path.join('/tmp', `feishu-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
    await responseAny.writeFile(tempPath);
    const buffer = await fs.readFile(tempPath);
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

async function downloadInboundAttachment(client, message, config, mediaDir) {
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
    const buffer = await readFeishuResponseBuffer(response);
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
    const buffer = await readFeishuResponseBuffer(response);
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

export async function startFeishuBridge(config, mediaDir, onInboundMessage) {
  const log = createLogger('feishu-bridge');
  const client = createClient(config);
  const wsClient = createWsClient(config);
  const dispatcher = createDispatcher(config);

  dispatcher.register({
    'im.message.receive_v1': async (data) => {
      const event = data;
      const message = event?.message;
      if (!message) {
        return;
      }
      const text = parseInboundText(message);
      const chatId = message.chat_id;
      const messageId = message.message_id;
      const chatType = message.chat_type;
      const senderOpenId = event?.sender?.sender_id?.open_id || '';

      const attachment = await downloadInboundAttachment(client, message, config, mediaDir).catch((error) => {
        log.warn(`attachment download failed for ${messageId}: ${error.message}`);
        return null;
      });

      if (!text && !attachment) {
        return;
      }

      await onInboundMessage({
        peerId: senderOpenId || chatId,
        text: text || `[${message.message_type || 'message'}]`,
        attachments: attachment ? [attachment] : [],
        meta: {
          chatId,
          messageId,
          chatType,
          senderOpenId,
        },
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
      const textChunks = splitText(reply.text || '', config.chunkChars).filter(Boolean);
      for (const chunk of textChunks) {
        if (replyMeta?.messageId) {
          await client.im.message.reply({
            path: { message_id: replyMeta.messageId },
            data: {
              content: JSON.stringify({ text: chunk }),
              msg_type: 'text',
            },
          });
        } else {
          await client.im.message.create({
            params: { receive_id_type: 'open_id' },
            data: {
              receive_id: target,
              content: JSON.stringify({ text: chunk }),
              msg_type: 'text',
            },
          });
        }
      }

      for (const media of parseReplyMedia(reply)) {
        if (media.kind === 'image') {
          const imageKey = await uploadImage(client, media.path);
          const payload = { content: JSON.stringify({ image_key: imageKey }), msg_type: 'image' };
          if (replyMeta?.messageId) {
            await client.im.message.reply({ path: { message_id: replyMeta.messageId }, data: payload });
          } else {
            await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: target, ...payload } });
          }
          continue;
        }

        const fileKey = await uploadFile(client, media.path);
        const payload = { content: JSON.stringify({ file_key: fileKey }), msg_type: 'file' };
        if (replyMeta?.messageId) {
          await client.im.message.reply({ path: { message_id: replyMeta.messageId }, data: payload });
        } else {
          await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: target, ...payload } });
        }
      }
    },
  };
}
