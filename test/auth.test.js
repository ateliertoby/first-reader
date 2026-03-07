import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TokenCache } from '../src/auth.js';

describe('TokenCache', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('saves and loads token cache', () => {
    const cachePath = path.join(tmpDir, 'token-cache.json');
    const cache = new TokenCache(cachePath);

    cache.save('{"AccessToken": {"key": "value"}}');
    const loaded = cache.load();

    assert.strictEqual(loaded, '{"AccessToken": {"key": "value"}}');
  });

  test('load returns null when no cache file exists', () => {
    const cachePath = path.join(tmpDir, 'nonexistent.json');
    const cache = new TokenCache(cachePath);

    assert.strictEqual(cache.load(), null);
  });

  test('creates parent directory if missing', () => {
    const cachePath = path.join(tmpDir, 'subdir', 'token-cache.json');
    const cache = new TokenCache(cachePath);

    cache.save('{"test": true}');
    assert.ok(fs.existsSync(cachePath));
  });
});
