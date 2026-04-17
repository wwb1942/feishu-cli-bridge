import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

async function loadLockfilePackages() {
  const lockfile = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  return lockfile.packages;
}

test('package-lock pins axios to a safe version', async () => {
  const packages = await loadLockfilePackages();
  const version = packages['node_modules/axios']?.version;
  assert.ok(version, 'expected axios to be present in package-lock.json');
  assert.equal(compareVersions(version, '1.15.0') >= 0, true);
});

test('package-lock pins follow-redirects to a safe version', async () => {
  const packages = await loadLockfilePackages();
  const version = packages['node_modules/follow-redirects']?.version;
  assert.ok(version, 'expected follow-redirects to be present in package-lock.json');
  assert.equal(compareVersions(version, '1.15.12') >= 0, true);
});

test('package-lock pins protobufjs to a safe version', async () => {
  const packages = await loadLockfilePackages();
  const version = packages['node_modules/protobufjs']?.version;
  assert.ok(version, 'expected protobufjs to be present in package-lock.json');
  assert.equal(compareVersions(version, '7.5.5') >= 0, true);
});
