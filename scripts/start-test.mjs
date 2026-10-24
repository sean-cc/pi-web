import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from './start.mjs';

test('compareVersions orders releases correctly', () => {
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0);
  assert.equal(compareVersions('v1.4.0', '1.4.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.4.1', '1.4.0'), 1);
  assert.equal(compareVersions('1.4.0', '1.5.0'), -1);
});

test('compareVersions treats a release as newer than its prerelease', () => {
  assert.equal(compareVersions('1.5.0', '1.5.0-beta.1'), 1);
  assert.equal(compareVersions('1.5.0-beta.2', '1.5.0-beta.1'), 1);
  assert.equal(compareVersions('1.5.0-beta.1', '1.5.0'), -1);
});
