import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('package.json uses a recursive test glob', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node --test tests/**/*.test.js');
});

test('bridge-app image reference regex does not contain garbled legacy text', async () => {
  const source = await fs.readFile(new URL('../src/bridge-app.js', import.meta.url), 'utf8');
  assert.equal(source.includes('杩欏紶'), false);
  assert.equal(source.includes('鍥剧墖'), false);
  assert.equal(source.includes('鍥鹃噷'), false);
  assert.equal(source.includes('鎴浘'), false);
  assert.equal(source.includes('闄勪欢'), false);
});
