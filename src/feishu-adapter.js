import * as Lark from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';

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

function parseTextContent(message) {
  if (!message?.content) {
    return '';
  }
  try {
    const parsed = JSON.parse(message.content);
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return '';
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

export async function startFeishuBridge(config, onInboundMessage) {
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
      const text = parseTextContent(message);
      if (!text) {
        return;
      }
      const chatId = message.chat_id;
      const messageId = message.message_id;
      const chatType = message.chat_type;
      const senderOpenId = event?.sender?.sender_id?.open_id || '';
      await onInboundMessage({
        peerId: senderOpenId || chatId,
        text,
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
    async sendText(target, text, replyMeta) {
      const chunks = splitText(text, config.chunkChars);
      for (const chunk of chunks) {
        if (replyMeta?.messageId) {
          await client.im.message.reply({
            path: { message_id: replyMeta.messageId },
            data: {
              content: JSON.stringify({ text: chunk }),
              msg_type: 'text',
            },
          });
          continue;
        }

        await client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: target,
            content: JSON.stringify({ text: chunk }),
            msg_type: 'text',
          },
        });
      }
    },
  };
}
