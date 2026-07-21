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
    const p = writeConfig({
      model: 'claude-sonnet-5', timezone: 'Asia/Hong_Kong',
      idleHours: 12, renderDeadlineHours: 4, readBodyCap: 50,
      ownerName: 'Alex', replyLanguage: 'French'
    });
    const cfg = loadAgentConfig(p);
    assert.strictEqual(cfg.model, 'claude-sonnet-5');
    assert.strictEqual(cfg.timezone, 'Asia/Hong_Kong');
    assert.strictEqual(cfg.idleHours, 12);
    assert.strictEqual(cfg.renderDeadlineHours, 4);
    assert.strictEqual(cfg.readBodyCap, 50);
    assert.strictEqual(cfg.ownerName, 'Alex');
    assert.strictEqual(cfg.replyLanguage, 'French');
  });

  test('applies defaults for missing optional fields', () => {
    const p = writeConfig({ model: 'claude-sonnet-5' });
    const cfg = loadAgentConfig(p);
    assert.strictEqual(cfg.timezone, 'Asia/Hong_Kong');
    assert.strictEqual(cfg.idleHours, 24);
    assert.strictEqual(cfg.renderDeadlineHours, 8);
    assert.strictEqual(cfg.readBodyCap, 40);
    assert.strictEqual(cfg.ownerName, 'the user');
    assert.strictEqual(cfg.replyLanguage, 'English');
  });

  test('throws on missing model', () => {
    const p = writeConfig({ timezone: 'UTC' });
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

  test('non-positive idleHours falls back to default 24', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', idleHours: 0 });
    assert.strictEqual(loadAgentConfig(p).idleHours, 24);
  });

  test('non-positive renderDeadlineHours falls back to default 8', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', renderDeadlineHours: -1 });
    assert.strictEqual(loadAgentConfig(p).renderDeadlineHours, 8);
  });

  test('non-positive readBodyCap falls back to default 40', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', readBodyCap: 0 });
    assert.strictEqual(loadAgentConfig(p).readBodyCap, 40);
  });

  test('non-number idleHours falls back to default', () => {
    const p = writeConfig({ model: 'claude-sonnet-5', idleHours: 'auto' });
    assert.strictEqual(loadAgentConfig(p).idleHours, 24);
  });

  test('loads config/agent.example.json via explicit path', () => {
    const examplePath = path.join(import.meta.dirname, '..', 'config', 'agent.example.json');
    const cfg = loadAgentConfig(examplePath);
    assert.strictEqual(cfg.model, 'claude-sonnet-4-6');
    assert.strictEqual(cfg.idleHours, 24);
    assert.strictEqual(cfg.renderDeadlineHours, 8);
    assert.strictEqual(cfg.readBodyCap, 40);
    assert.strictEqual(cfg.ownerName, 'Alex');
    assert.strictEqual(cfg.replyLanguage, 'English');
  });

  test('missing file throws bootstrap message', () => {
    assert.throws(
      () => loadAgentConfig('/tmp/nonexistent-outlook-cli-test/agent.json'),
      { message: /Copy config\/agent\.example\.json/ }
    );
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

test('renderModel defaults to model when absent, used when present', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-cfg-'));
  const p = path.join(tmp, 'agent.json');

  fs.writeFileSync(p, JSON.stringify({ model: 'claude-sonnet-4-6' }));
  assert.strictEqual(loadAgentConfig(p).renderModel, 'claude-sonnet-4-6');

  fs.writeFileSync(p, JSON.stringify({ model: 'claude-sonnet-4-6', renderModel: 'claude-opus-4-6' }));
  assert.strictEqual(loadAgentConfig(p).renderModel, 'claude-opus-4-6');

  fs.rmSync(tmp, { recursive: true });
});
