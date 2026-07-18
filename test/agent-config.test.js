import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadAgentConfig, requireEnv } from '../src/agent/config.js';

describe('loadAgentConfig', () => {
  let tmpDir;

  function writeConfig(obj) {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-agentcfg-'));
    const p = path.join(tmpDir, 'agent.json');
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true });
      tmpDir = null;
    }
  });

  test('loads valid config with all fields', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', reportTime: '08:30', timezone: 'Asia/Hong_Kong' });
    const cfg = loadAgentConfig(p);
    assert.strictEqual(cfg.model, 'claude-sonnet-5');
    assert.strictEqual(cfg.reportTime, '08:30');
    assert.strictEqual(cfg.timezone, 'Asia/Hong_Kong');
  });

  test('applies defaults for missing optional fields', () => {
    const p = writeConfig({ model: 'claude-sonnet-5' });
    const cfg = loadAgentConfig(p);
    assert.strictEqual(cfg.reportTime, '08:30');
    assert.strictEqual(cfg.timezone, 'Asia/Hong_Kong');
  });

  test('throws on missing model', () => {
    const p = writeConfig({ reportTime: '09:00' });
    assert.throws(() => loadAgentConfig(p), { message: /model is required/ });
  });

  test('throws on empty model', () => {
    const p = writeConfig({ model: '' });
    assert.throws(() => loadAgentConfig(p), { message: /model is required/ });
  });

  test('throws on non-string model', () => {
    const p = writeConfig({ model: 42 });
    assert.throws(() => loadAgentConfig(p), { message: /model is required/ });
  });

  test('accepts reportTime "auto"', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', reportTime: 'auto' });
    const cfg = loadAgentConfig(p);
    assert.strictEqual(cfg.reportTime, 'auto');
  });

  test('accepts valid 24h reportTime values', () => {
    for (const t of ['00:00', '08:30', '13:45', '23:59']) {
      const p = writeConfig({ model: 'claude-sonnet-5', reportTime: t });
      const cfg = loadAgentConfig(p);
      assert.strictEqual(cfg.reportTime, t);
    }
  });

  test('throws on invalid reportTime format', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', reportTime: '8:30' });
    assert.throws(() => loadAgentConfig(p), { message: /reportTime/ });
  });

  test('throws on reportTime = 25:00', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', reportTime: '25:00' });
    assert.throws(() => loadAgentConfig(p), { message: /reportTime/ });
  });

  test('throws on reportTime = 12:60', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', reportTime: '12:60' });
    assert.throws(() => loadAgentConfig(p), { message: /reportTime/ });
  });

  test('throws on numeric reportTime', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', reportTime: 830 });
    assert.throws(() => loadAgentConfig(p), { message: /reportTime/ });
  });

  test('throws on empty timezone', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', timezone: '' });
    assert.throws(() => loadAgentConfig(p), { message: /timezone/ });
  });

  test('throws on whitespace-only timezone', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', timezone: '   ' });
    assert.throws(() => loadAgentConfig(p), { message: /timezone/ });
  });

  test('throws on non-string timezone', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', timezone: 8 });
    assert.throws(() => loadAgentConfig(p), { message: /timezone/ });
  });

  test('loads the real config/agent.json via default path', () => {
    const cfg = loadAgentConfig();
    assert.strictEqual(cfg.model, 'claude-sonnet-4-6');
  });
});

describe('requireEnv', () => {
  const KEY = '__OUTLOOK_CLI_TEST_REQUIRE_ENV__';

  afterEach(() => {
    delete process.env[KEY];
  });

  test('returns value when set', () => {
    process.env[KEY] = 'test-value';
    assert.strictEqual(requireEnv(KEY), 'test-value');
  });

  test('throws when not set', () => {
    delete process.env[KEY];
    assert.throws(() => requireEnv(KEY), { message: new RegExp(KEY) });
  });

  test('throws when empty string', () => {
    process.env[KEY] = '';
    assert.throws(() => requireEnv(KEY), { message: new RegExp(KEY) });
  });
});
