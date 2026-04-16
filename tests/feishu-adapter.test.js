import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  downloadInboundAttachment,
  extractMentionOpenIds,
  buildReplyTarget,
  serializeTextForFeishu,
  shouldForwardAssistantGroupMessage,
  resolveBotIdentity,
} from '../src/feishu-adapter.js';

test('extractMentionOpenIds reads open ids from mention payloads', () => {
  const ids = extractMentionOpenIds({
    mentions: [
      { id: { open_id: 'ou_bot_1' } },
      { id: { open_id: 'ou_bot_2' } },
      { id: { user_id: 'ignored' } },
    ],
  });

  assert.deepEqual(ids, ['ou_bot_1', 'ou_bot_2']);
});

test('buildReplyTarget uses chat_id for group replies and open_id for direct replies', () => {
  assert.deepEqual(
    buildReplyTarget({ chatType: 'group', chatId: 'oc_chat', senderOpenId: 'ou_user' }),
    { receiveIdType: 'chat_id', receiveId: 'oc_chat' },
  );

  assert.deepEqual(
    buildReplyTarget({ chatType: 'p2p', chatId: 'oc_chat', senderOpenId: 'ou_user' }),
    { receiveIdType: 'open_id', receiveId: 'ou_user' },
  );
});

test('shouldForwardAssistantGroupMessage only accepts leading protocol markers', () => {
  assert.equal(shouldForwardAssistantGroupMessage(' [delegate] [task:abc123] @bot handle this'), true);
  assert.equal(shouldForwardAssistantGroupMessage('[delegate][task:abc123] @bot handle this'), true);
  assert.equal(shouldForwardAssistantGroupMessage('  [delegate]   [task:abc123] @bot handle this'), true);
  assert.equal(shouldForwardAssistantGroupMessage(' [task:abc123] result text'), true);
  assert.equal(shouldForwardAssistantGroupMessage('done [task:abc123] later'), false);
  assert.equal(shouldForwardAssistantGroupMessage('normal assistant chatter'), false);
});

test('serializeTextForFeishu converts target open ids into real Feishu mentions', () => {
  const serialized = serializeTextForFeishu(
    '[delegate] [task:abc123] @ou_bot_target investigate this',
    ['ou_bot_target'],
  );

  assert.equal(
    serialized,
    '[delegate] [task:abc123] <at user_id="ou_bot_target"></at> investigate this',
  );
});

test('resolveBotIdentity prefers configured bot open id', async () => {
  const botOpenId = await resolveBotIdentity(
    {
      bot: {
        v3: {
          info: {
            get: async () => ({ data: { open_id: 'ou_remote' } }),
          },
        },
      },
    },
    { botOpenId: 'ou_configured' },
  );

  assert.equal(botOpenId, 'ou_configured');
});

test('resolveBotIdentity falls back to bot info endpoint', async () => {
  const botOpenId = await resolveBotIdentity(
    {
      bot: {
        v3: {
          info: {
            get: async () => ({ data: { bot_open_id: 'ou_remote' } }),
          },
        },
      },
    },
    { botOpenId: '' },
  );

  assert.equal(botOpenId, 'ou_remote');
});

test('resolveBotIdentity falls back to application info endpoint when bot info is unavailable', async () => {
  const botOpenId = await resolveBotIdentity(
    {
      application: {
        v6: {
          application: {
            get: async () => ({ data: { app: { bot: { open_id: 'ou_app_bot' } } } }),
          },
        },
      },
    },
    { botOpenId: '', appId: 'cli_xxx' },
  );

  assert.equal(botOpenId, 'ou_app_bot');
});

test('resolveBotIdentity logs resolver failures before falling back', async () => {
  const debugLogs = [];
  const warnLogs = [];

  const botOpenId = await resolveBotIdentity(
    {
      bot: {
        v3: {
          info: {
            get: async () => {
              throw new Error('permission denied');
            },
          },
        },
      },
      application: {
        v6: {
          application: {
            get: async () => ({ data: { app: { bot: { open_id: 'ou_app_bot' } } } }),
          },
        },
      },
    },
    { botOpenId: '', appId: 'cli_xxx' },
    {
      debug(message) {
        debugLogs.push(message);
      },
      warn(message) {
        warnLogs.push(message);
      },
    },
  );

  assert.equal(botOpenId, 'ou_app_bot');
  assert.equal(debugLogs.some(message => message.includes('bot.v3.info.get')), true);
  assert.equal(debugLogs.some(message => message.includes('application.v6.application.get')), true);
  assert.equal(warnLogs.some(message => message.includes('permission denied')), true);
});

test('downloadInboundAttachment rejects attachments larger than FEISHU_MAX_INBOUND_BYTES', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-oversize-'));

  await assert.rejects(
    () => downloadInboundAttachment(
      {
        im: {
          messageResource: {
            get: async () => Buffer.alloc(8, 1),
          },
        },
      },
      {
        message_id: 'om_image',
        message_type: 'image',
        content: JSON.stringify({
          image_key: 'img_key',
          file_name: 'image.png',
        }),
      },
      { maxInboundBytes: 4 },
      tempDir,
    ),
    /FEISHU_MAX_INBOUND_BYTES|4 bytes|exceeds/i,
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});
