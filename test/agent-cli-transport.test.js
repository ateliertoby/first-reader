// Tests for cli-transport.js — queue-based LLM transport

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  callCliLLM,
  cleanQueue,
  _setQueueTransportForTesting,
} from '../src/agent/cli-transport.js';

const FAST_POLL = 50; // ms — speed up file-based tests

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-cli-transport-'));
}

function writeResult(queueDir, id, result) {
  const dir = path.join(queueDir, 'results');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(result));
}

// Wait for N request files to appear in the requests dir
async function waitForRequests(reqDir, count, maxWait = 2000) {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      const files = fs.readdirSync(reqDir).filter(f => f.endsWith('.json') && !f.startsWith('tmp-'));
      if (files.length >= count) return files;
    } catch { /* dir may not exist yet */ }
    await new Promise(r => setTimeout(r, 30));
  }
  const files = fs.readdirSync(reqDir).filter(f => f.endsWith('.json') && !f.startsWith('tmp-'));
  return files;
}

afterEach(() => {
  _setQueueTransportForTesting(null);
});

// --- Request file shape ---

describe('request file writing', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  test('writes request JSON with correct shape', async () => {
    const callPromise = callCliLLM({
      kind: 'intent',
      system: 'test system',
      user: 'test user',
      tools: [],
      model: 'claude-sonnet-4-6',
      timeoutMs: 500,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    }).catch(() => {}); // timeout expected

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    assert.strictEqual(files.length, 1);

    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));
    assert.strictEqual(req.kind, 'intent');
    assert.strictEqual(req.model, 'claude-sonnet-4-6');
    assert.strictEqual(req.user, 'test user');
    assert.ok(req.system.includes('test system'));
    assert.ok(req.id);
    assert.ok(req.ts);
    assert.deepStrictEqual(req.tools, []);

    // JSON-only instruction appended for JSON kinds
    assert.ok(req.system.includes('Respond with ONLY valid JSON'));

    await callPromise;
  });

  test('deep_verify request does NOT get JSON instruction', async () => {
    const callPromise = callCliLLM({
      kind: 'deep_verify',
      system: 'verify system',
      user: 'verify user',
      tools: ['WebSearch'],
      model: 'claude-sonnet-4-6',
      timeoutMs: 500,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    }).catch(() => {});

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));

    assert.strictEqual(req.kind, 'deep_verify');
    assert.ok(!req.system.includes('Respond with ONLY valid JSON'));
    assert.deepStrictEqual(req.tools, ['WebSearch']);

    await callPromise;
  });
});

// --- Happy path: ok result per kind ---

describe('ok result happy path', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  async function callWithResult(kind, resultText) {
    const promise = callCliLLM({
      kind,
      system: 'sys',
      user: 'usr',
      model: 'claude-sonnet-4-6',
      timeoutMs: 5000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));

    writeResult(tmpDir, req.id, { id: req.id, ts: new Date().toISOString(), ok: true, text: resultText });

    return promise;
  }

  test('render kind: parses JSON result with required keys', async () => {
    const data = {
      message_text: 'test report',
      new_questions: [],
      auto_resolved_reminders: [],
      junk_flags: [],
    };
    const result = await callWithResult('render', JSON.stringify(data));
    assert.deepStrictEqual(result, data);
  });

  test('intent kind: parses JSON result with required keys', async () => {
    const data = { ops: [], reply_text: 'ok', needs_clarification: false };
    const result = await callWithResult('intent', JSON.stringify(data));
    assert.deepStrictEqual(result, data);
  });

  test('audit kind: parses JSON result with required keys', async () => {
    const data = { suspects: [], clean: true };
    const result = await callWithResult('audit', JSON.stringify(data));
    assert.deepStrictEqual(result, data);
  });

  test('inspect kind: parses JSON result with required keys', async () => {
    const data = { verdict: 'safe', reasons: ['clean'], evidence_lines: [] };
    const result = await callWithResult('inspect', JSON.stringify(data));
    assert.deepStrictEqual(result, data);
  });
});

// --- JSON extraction from fenced output ---

describe('JSON extraction from code fences', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  test('extracts JSON from ```json ... ``` fences', async () => {
    const data = { ops: [], reply_text: 'fenced', needs_clarification: false };
    const fenced = '```json\n' + JSON.stringify(data) + '\n```';

    const promise = callCliLLM({
      kind: 'intent',
      system: 'sys',
      user: 'usr',
      model: 'claude-sonnet-4-6',
      timeoutMs: 5000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));
    writeResult(tmpDir, req.id, { id: req.id, ts: new Date().toISOString(), ok: true, text: fenced });

    const result = await promise;
    assert.deepStrictEqual(result, data);
  });

  test('extracts JSON from bare ``` ... ``` fences', async () => {
    const data = { suspects: [], clean: true };
    const fenced = '```\n' + JSON.stringify(data) + '\n```';

    const promise = callCliLLM({
      kind: 'audit',
      system: 'sys',
      user: 'usr',
      model: 'claude-sonnet-4-6',
      timeoutMs: 5000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));
    writeResult(tmpDir, req.id, { id: req.id, ts: new Date().toISOString(), ok: true, text: fenced });

    const result = await promise;
    assert.deepStrictEqual(result, data);
  });
});

// --- Missing required key -> retry ---

describe('retry on missing required key', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  test('missing key triggers retry with CRITICAL preamble, succeeds on second', async () => {
    const promise = callCliLLM({
      kind: 'intent',
      system: 'sys',
      user: 'usr',
      model: 'claude-sonnet-4-6',
      timeoutMs: 10000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');

    // Wait for first request
    let files = await waitForRequests(reqDir, 1);
    assert.strictEqual(files.length, 1);
    const firstReq = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));

    // First result: missing 'needs_clarification' key
    const badData = { ops: [], reply_text: 'incomplete' };
    writeResult(tmpDir, firstReq.id, { id: firstReq.id, ts: new Date().toISOString(), ok: true, text: JSON.stringify(badData) });

    // Wait for retry request (second file appears)
    files = await waitForRequests(reqDir, 2);
    assert.strictEqual(files.length, 2, 'Should have original + retry request');

    // Find the retry request (different id from first)
    const retryFile = files.find(f => f !== `${firstReq.id}.json`);
    const retryReq = JSON.parse(fs.readFileSync(path.join(reqDir, retryFile), 'utf8'));

    // Retry request has CRITICAL preamble
    assert.ok(retryReq.system.includes('CRITICAL'));
    assert.ok(retryReq.system.includes('Previous attempt failed'));

    // Second result: valid
    const goodData = { ops: [], reply_text: 'good', needs_clarification: false };
    writeResult(tmpDir, retryReq.id, { id: retryReq.id, ts: new Date().toISOString(), ok: true, text: JSON.stringify(goodData) });

    const result = await promise;
    assert.deepStrictEqual(result, goodData);
  });

  test('retry exhausted throws', async () => {
    const promise = callCliLLM({
      kind: 'render',
      system: 'sys',
      user: 'usr',
      model: 'claude-sonnet-4-6',
      timeoutMs: 10000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');

    // Wait for first request
    let files = await waitForRequests(reqDir, 1);
    const firstReq = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));

    // First result: bad JSON
    writeResult(tmpDir, firstReq.id, { id: firstReq.id, ts: new Date().toISOString(), ok: true, text: 'not json at all' });

    // Wait for retry request
    files = await waitForRequests(reqDir, 2);
    const retryFile = files.find(f => f !== `${firstReq.id}.json`);
    const retryReq = JSON.parse(fs.readFileSync(path.join(reqDir, retryFile), 'utf8'));

    // Second result: also bad
    writeResult(tmpDir, retryReq.id, { id: retryReq.id, ts: new Date().toISOString(), ok: true, text: 'still not json' });

    await assert.rejects(promise, /not valid JSON after retry/);
  });
});

// --- ok:false with auth_expired ---

describe('error results', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  test('ok:false auth_expired throws with code property', async () => {
    const promise = callCliLLM({
      kind: 'intent',
      system: 'sys',
      user: 'usr',
      model: 'claude-sonnet-4-6',
      timeoutMs: 5000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));

    writeResult(tmpDir, req.id, {
      id: req.id, ts: new Date().toISOString(),
      ok: false, error: 'auth_expired', detail: 'login required',
    });

    try {
      await promise;
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.code, 'auth_expired');
      assert.ok(err.message.includes('login'));
    }
  });

  test('ok:false generic error throws with error code', async () => {
    const promise = callCliLLM({
      kind: 'render',
      system: 'sys',
      user: 'usr',
      model: 'claude-sonnet-4-6',
      timeoutMs: 5000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));

    writeResult(tmpDir, req.id, {
      id: req.id, ts: new Date().toISOString(),
      ok: false, error: 'claude_error', detail: 'rate limited',
    });

    try {
      await promise;
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.code, 'claude_error');
      assert.ok(err.message.includes('rate limited'));
    }
  });
});

// --- Timeout ---

describe('timeout', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  test('timeout throws when no result arrives', async () => {
    await assert.rejects(
      callCliLLM({
        kind: 'intent',
        system: 'sys',
        user: 'usr',
        model: 'claude-sonnet-4-6',
        timeoutMs: 200,
        _queueDir: tmpDir,
        _pollIntervalMs: FAST_POLL,
      }),
      (err) => {
        assert.strictEqual(err.code, 'timeout');
        assert.ok(err.message.includes('timeout'));
        return true;
      }
    );
  });
});

// --- deep_verify passthrough ---

describe('deep_verify passthrough', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  test('returns raw text without JSON parsing', async () => {
    const rawText = 'This claim appears to be true based on web search results.';
    const promise = callCliLLM({
      kind: 'deep_verify',
      system: 'sys',
      user: 'usr',
      tools: ['WebSearch'],
      model: 'claude-sonnet-4-6',
      timeoutMs: 5000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));

    writeResult(tmpDir, req.id, { id: req.id, ts: new Date().toISOString(), ok: true, text: rawText });

    const result = await promise;
    assert.strictEqual(result, rawText);
  });

  test('does not attempt JSON parse even for JSON-like text', async () => {
    const jsonText = '{"this": "is json but should be returned as string"}';
    const promise = callCliLLM({
      kind: 'deep_verify',
      system: 'sys',
      user: 'usr',
      tools: ['WebSearch'],
      model: 'claude-sonnet-4-6',
      timeoutMs: 5000,
      _queueDir: tmpDir,
      _pollIntervalMs: FAST_POLL,
    });

    const reqDir = path.join(tmpDir, 'requests');
    const files = await waitForRequests(reqDir, 1);
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));

    writeResult(tmpDir, req.id, { id: req.id, ts: new Date().toISOString(), ok: true, text: jsonText });

    const result = await promise;
    assert.strictEqual(result, jsonText);
  });
});

// --- cleanQueue ---

describe('cleanQueue', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  test('deletes files older than 1h, keeps recent ones', () => {
    const now = new Date('2026-07-18T12:00:00Z');
    const reqDir = path.join(tmpDir, 'requests');
    const resDir = path.join(tmpDir, 'results');
    fs.mkdirSync(reqDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });

    // Old file (2h ago)
    const oldReqPath = path.join(reqDir, 'old-req.json');
    fs.writeFileSync(oldReqPath, '{}');
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000);
    fs.utimesSync(oldReqPath, twoHoursAgo, twoHoursAgo);

    // Old result
    const oldResPath = path.join(resDir, 'old-res.json');
    fs.writeFileSync(oldResPath, '{}');
    fs.utimesSync(oldResPath, twoHoursAgo, twoHoursAgo);

    // Recent file (10 min ago)
    const recentReqPath = path.join(reqDir, 'recent-req.json');
    fs.writeFileSync(recentReqPath, '{}');
    const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
    fs.utimesSync(recentReqPath, tenMinAgo, tenMinAgo);

    // Recent result
    const recentResPath = path.join(resDir, 'recent-res.json');
    fs.writeFileSync(recentResPath, '{}');
    fs.utimesSync(recentResPath, tenMinAgo, tenMinAgo);

    cleanQueue(now.toISOString(), tmpDir);

    // Old files deleted
    assert.strictEqual(fs.existsSync(oldReqPath), false, 'old request should be deleted');
    assert.strictEqual(fs.existsSync(oldResPath), false, 'old result should be deleted');

    // Recent files kept
    assert.strictEqual(fs.existsSync(recentReqPath), true, 'recent request should be kept');
    assert.strictEqual(fs.existsSync(recentResPath), true, 'recent result should be kept');
  });

  test('protectedIds exempts files from cleanup', () => {
    const now = new Date('2026-07-18T12:00:00Z');
    const reqDir = path.join(tmpDir, 'requests');
    const resDir = path.join(tmpDir, 'results');
    fs.mkdirSync(reqDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });

    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000);

    // Old file that IS protected
    const protectedReqPath = path.join(reqDir, 'protected-id.json');
    fs.writeFileSync(protectedReqPath, '{}');
    fs.utimesSync(protectedReqPath, twoHoursAgo, twoHoursAgo);

    const protectedResPath = path.join(resDir, 'protected-id.json');
    fs.writeFileSync(protectedResPath, '{}');
    fs.utimesSync(protectedResPath, twoHoursAgo, twoHoursAgo);

    // Old file that is NOT protected
    const unprotectedPath = path.join(reqDir, 'unprotected-id.json');
    fs.writeFileSync(unprotectedPath, '{}');
    fs.utimesSync(unprotectedPath, twoHoursAgo, twoHoursAgo);

    cleanQueue(now.toISOString(), tmpDir, ['protected-id']);

    // Protected files survive despite being old
    assert.strictEqual(fs.existsSync(protectedReqPath), true, 'protected request should survive');
    assert.strictEqual(fs.existsSync(protectedResPath), true, 'protected result should survive');

    // Unprotected old file deleted
    assert.strictEqual(fs.existsSync(unprotectedPath), false, 'unprotected old request should be deleted');
  });

  test('handles missing queue directories gracefully', () => {
    assert.doesNotThrow(() => {
      cleanQueue(new Date().toISOString(), path.join(tmpDir, 'nonexistent'));
    });
  });

  test('ignores non-json files', () => {
    const reqDir = path.join(tmpDir, 'requests');
    fs.mkdirSync(reqDir, { recursive: true });

    const txtPath = path.join(reqDir, 'readme.txt');
    fs.writeFileSync(txtPath, 'not json');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(txtPath, old, old);

    cleanQueue(new Date().toISOString(), tmpDir);

    assert.strictEqual(fs.existsSync(txtPath), true, 'non-json files should be left alone');
  });
});

// --- Module-level test hook ---

describe('_setQueueTransportForTesting hook', () => {
  test('intercepts callCliLLM when set', async () => {
    let captured = null;
    _setQueueTransportForTesting((args) => {
      captured = args;
      return { ops: [], reply_text: 'mock', needs_clarification: false };
    });

    const result = await callCliLLM({
      kind: 'intent',
      system: 'test sys',
      user: 'test usr',
      model: 'claude-sonnet-4-6',
    });

    assert.ok(captured);
    assert.strictEqual(captured.kind, 'intent');
    assert.strictEqual(captured.system, 'test sys');
    assert.strictEqual(captured.user, 'test usr');
    assert.strictEqual(result.reply_text, 'mock');
  });
});

// --- Call-site wiring: production path invokes callCliLLM with correct kind ---

describe('call-site wiring', () => {
  afterEach(() => {
    _setQueueTransportForTesting(null);
  });

  test('renderReport invokes queue transport with kind=render', async () => {
    let captured = null;
    _setQueueTransportForTesting((args) => {
      captured = args;
      return {
        message_text: 'test',
        new_questions: [],
        auto_resolved_reminders: [],
        junk_flags: [],
      };
    });

    const { _setLLMTransportForTesting, renderReport } = await import('../src/agent/llm.js');
    _setLLMTransportForTesting(null);

    await renderReport({
      model: 'claude-sonnet-4-6',
      reportJson: { window: {} },
      notesContent: '',
    });

    assert.ok(captured);
    assert.strictEqual(captured.kind, 'render');
    assert.strictEqual(captured.model, 'claude-sonnet-4-6');

    _setLLMTransportForTesting(null);
  });

  test('parseIntent invokes queue transport with kind=intent', async () => {
    let captured = null;
    _setQueueTransportForTesting((args) => {
      captured = args;
      return { ops: [], reply_text: 'ok', needs_clarification: false };
    });

    const { _setIntentTransportForTesting, parseIntent } = await import('../src/agent/intent.js');
    _setIntentTransportForTesting(null);

    await parseIntent({
      model: 'claude-sonnet-4-6',
      userText: 'test',
      context: {},
    });

    assert.ok(captured);
    assert.strictEqual(captured.kind, 'intent');

    _setIntentTransportForTesting(null);
  });

  test('runDeepVerify invokes queue transport with kind=deep_verify and WebSearch tool', async () => {
    let captured = null;
    _setQueueTransportForTesting((args) => {
      captured = args;
      return 'verified text';
    });

    const { _setDeepVerifyTransportForTesting, runDeepVerify } = await import('../src/agent/intent.js');
    _setDeepVerifyTransportForTesting(null);

    await runDeepVerify({
      model: 'claude-sonnet-4-6',
      claim: 'test claim',
      context: 'test context',
    });

    assert.ok(captured);
    assert.strictEqual(captured.kind, 'deep_verify');
    assert.deepStrictEqual(captured.tools, ['WebSearch']);

    _setDeepVerifyTransportForTesting(null);
  });

  test('audit LLM call invokes queue transport with kind=audit', async () => {
    let captured = null;
    _setQueueTransportForTesting((args) => {
      captured = args;
      return { suspects: [], clean: true };
    });

    const { _setAuditTransportForTesting, runFolderAudit } = await import('../src/agent/audit.js');
    _setAuditTransportForTesting(null);

    const auditCfgPath = path.join(os.tmpdir(), `cli-transport-audit-cfg-${Date.now()}.json`);
    fs.writeFileSync(auditCfgPath, JSON.stringify({ model: 'claude-sonnet-4-6' }));

    await runFolderAudit({
      dry: true,
      _agentDbPath: path.join(os.tmpdir(), `cli-transport-audit-${Date.now()}.db`),
      _outboxDir: path.join(os.tmpdir(), `cli-transport-audit-outbox-${Date.now()}`),
      _agentConfigPath: auditCfgPath,
      _now: '2026-07-18T10:00:00Z',
      _graphGet: async (url) => {
        if (url.includes("displayName eq 'Accounting'")) return { value: [{ id: 'a' }] };
        if (url.includes("displayName eq 'Notifications'")) return { value: [{ id: 'n' }] };
        if (url.includes('a/messages') || url.includes('n/messages')) {
          return { value: [{ from: { emailAddress: { address: 'x@y.com' } }, subject: 'Test', receivedDateTime: '2026-07-01T10:00:00Z' }] };
        }
        return { value: [] };
      },
    });

    assert.ok(captured);
    assert.strictEqual(captured.kind, 'audit');

    _setAuditTransportForTesting(null);
  });

  test('inspect verdict invokes queue transport with kind=inspect', async () => {
    let captured = null;
    _setQueueTransportForTesting((args) => {
      captured = args;
      return { verdict: 'safe', reasons: [], evidence_lines: [] };
    });

    const { _setInspectTransportForTesting, runInspection } =
      await import('../src/agent/inspect.js');
    _setInspectTransportForTesting(null);

    await runInspection('test-email-id', {
      graphGet: async () => ({
        subject: 'Test Subject',
        from: { emailAddress: { name: 'Test', address: 'test@example.com' } },
        replyTo: [],
        internetMessageHeaders: [],
        body: { contentType: 'HTML', content: '<p>Hello</p>' },
      }),
      model: 'claude-sonnet-4-6',
    });

    assert.ok(captured);
    assert.strictEqual(captured.kind, 'inspect');

    _setInspectTransportForTesting(null);
  });
});

describe('schema text in system prompt', () => {
  test('JSON kinds get their output schema appended; deep_verify does not', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { callCliLLM } = await import('../src/agent/cli-transport.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
    const reqDir = path.join(dir, 'requests');
    const resDir = path.join(dir, 'results');

    const p = callCliLLM({
      kind: 'render', system: 'base prompt', user: 'u', model: 'm',
      timeoutMs: 3000, _queueDir: dir, _pollIntervalMs: 50
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    const reqFile = fs.readdirSync(reqDir).find(f => f.endsWith('.json'));
    const req = JSON.parse(fs.readFileSync(path.join(reqDir, reqFile), 'utf8'));
    assert.ok(req.system.includes('message_text'), 'render schema keys must be in system prompt');
    assert.ok(req.system.includes('junk_flags'));
    assert.ok(req.system.includes('ONLY valid JSON'));
    // satisfy the pending call
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(path.join(resDir, reqFile), JSON.stringify({
      id: req.id, ts: 'x', ok: true,
      text: JSON.stringify({ message_text: 'm', new_questions: [], auto_resolved_reminders: [], junk_flags: [] })
    }));
    await p;

    const p2 = callCliLLM({
      kind: 'deep_verify', system: 'verify prompt', user: 'u', model: 'm',
      timeoutMs: 3000, _queueDir: dir, _pollIntervalMs: 50
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    // requests are worker-deleted in production; here the first file lingers - exclude it
    const req2File = fs.readdirSync(reqDir).find(f => f.endsWith('.json') && f !== reqFile);
    const req2 = JSON.parse(fs.readFileSync(path.join(reqDir, req2File), 'utf8'));
    assert.ok(!req2.system.includes('ONLY valid JSON'), 'deep_verify must not get JSON instruction');
    fs.writeFileSync(path.join(resDir, req2File), JSON.stringify({ id: req2.id, ts: 'x', ok: true, text: 'evidence' }));
    await p2;
    fs.rmSync(dir, { recursive: true });
  });
});
