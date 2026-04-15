import test from 'node:test';
import assert from 'node:assert/strict';

test('buildBridgePrompt injects DDS session reuse instructions for DDS tasks', async () => {
  const { buildBridgePrompt } = await import('../src/runner-utils.js');
  const prompt = buildBridgePrompt('SYSTEM', [], {
    text: '璁块棶dds锛岃繘鍏d锛?10椤圭洰锛岀偣鍑绘暟鎹垎鏋?>鍗冲腑鏌ヨ锛屽畬鎴愬悗鎴浘缁欐垜',
    attachments: [],
  });

  assert.match(prompt, /D:\\tools\\dds2-open\.cmd/);
  assert.match(prompt, /D:\\tools\\playwright-cli\.cmd/);
  assert.match(prompt, /Do not create a fresh in-memory Playwright browser for DDS tasks\./);
});

test('buildBridgePrompt does not inject DDS session reuse instructions for non-DDS tasks', async () => {
  const { buildBridgePrompt } = await import('../src/runner-utils.js');
  const prompt = buildBridgePrompt('SYSTEM', [], {
    text: 'Open https://example.com and take a screenshot',
    attachments: [],
  });

  assert.doesNotMatch(prompt, /D:\\tools\\dds2-open\.cmd/);
});
