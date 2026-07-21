import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgentReport, buildDegradedMessage } from '../src/agent/report.js';
import { AgentDB } from '../src/agent/db.js';
import { SortLogDB } from '../src/sorter/db.js';
import { _setTokenForTesting, setRetryDelays } from '../src/graph.js';
import { _setLLMTransportForTesting } from '../src/agent/llm.js';

// --- Test helpers ---

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'first-reader-agent-report-'));
}

function writeRules(dir, extra = []) {
  const p = path.join(dir, 'rules.json');
  fs.writeFileSync(p, JSON.stringify({
    guards: ['urgent'],
    settings: { minAgeHours: 6 },
    rules: [
      { id: 'mox-tx', bucket: 'accounting', domains: ['mox.com'], note: 'mox transactions' },
      { id: 'github-notif', bucket: 'notifications', domains: ['github.com'], note: 'github notifications' },
      { id: 'hketoll-reminder', bucket: 'notifications', domains: ['govhk.com'], note: 'reminder-class: toll payment' },
      { id: 'keep-test', bucket: 'keep', domains: ['important.com'], note: 'keep in inbox' },
      ...extra
    ]
  }));
  return p;
}

function writeAgentConfig(dir) {
  const p = path.join(dir, 'agent.json');
  fs.writeFileSync(p, JSON.stringify({
    model: 'claude-sonnet-5',
    idleHours: 24, renderDeadlineHours: 8, readBodyCap: 40
  }));
  return p;
}

function writeNotes(dir, content) {
  const p = path.join(dir, 'agent-notes.md');
  fs.writeFileSync(p, content);
  return p;
}

function insertSortRows(dbPath, rows) {
  const logDb = new SortLogDB(dbPath);
  for (const r of rows) logDb.insert(r);
  logDb.close();
}

function defaultLLMResponse() {
  return {
    message_text: 'Test report message',
    new_questions: [],
    auto_resolved_reminders: [],
    junk_flags: []
  };
}

// Standard options builder for runAgentReport
function opts(tmpDir, overrides = {}) {
  return {
    _agentDbPath: path.join(tmpDir, 'agent.db'),
    _sortDbPath: path.join(tmpDir, 'transactions.db'),
    _notesPath: path.join(tmpDir, 'agent-notes.md'),
    _outboxDir: path.join(tmpDir, 'outbox'),
    _rulesPath: path.join(tmpDir, 'rules.json'),
    _agentConfigPath: path.join(tmpDir, 'agent.json'),
    _queueDir: path.join(tmpDir, 'llm-queue'),
    _now: '2026-07-18T08:30:00Z',
    ...overrides
  };
}

// Default Graph mock: resolves well-known folders, returns empty folder list
function setupDefaultGraphMock() {
  globalThis.fetch = async (url) => {
    // Well-known folder resolution
    const wkMatch = url.match(/\/me\/mailFolders\/(sentitems|deleteditems|drafts|outbox|junkemail)\b/);
    if (wkMatch && !url.includes('/messages')) {
      return {
        ok: true, status: 200,
        json: async () => ({ id: `folder-${wkMatch[1]}`, displayName: wkMatch[1] })
      };
    }
    // Folder listing
    if (url.includes('/me/mailFolders') && url.includes('$top') && !url.includes('/messages')) {
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    }
    // Default: empty collection
    return { ok: true, status: 200, json: async () => ({ value: [] }) };
  };
}

// Graph mock with folders and messages
function setupFolderMock({ folders = [], folderMessages = {}, moveCalls = [], bodyResponses = {} } = {}) {
  globalThis.fetch = async (url, fetchOpts) => {
    // Move calls
    if (fetchOpts?.method === 'POST' && url.includes('/move')) {
      moveCalls.push(url);
      return { ok: true, status: 200, json: async () => ({ id: 'moved-new' }) };
    }
    // Body fetch
    const bodyMatch = url.match(/\/me\/messages\/([^?/]+)\?.*\$select=body/);
    if (bodyMatch && bodyResponses[bodyMatch[1]]) {
      return {
        ok: true, status: 200,
        json: async () => bodyResponses[bodyMatch[1]]
      };
    }
    if (bodyMatch) {
      return {
        ok: true, status: 200,
        json: async () => ({ body: { content: 'default body', contentType: 'text' } })
      };
    }
    // Well-known folder resolution
    const wkMatch = url.match(/\/me\/mailFolders\/(sentitems|deleteditems|drafts|outbox|junkemail)\b/);
    if (wkMatch && !url.includes('/messages')) {
      return {
        ok: true, status: 200,
        json: async () => ({ id: `folder-${wkMatch[1]}`, displayName: wkMatch[1] })
      };
    }
    // Folder listing
    if (url.includes('/me/mailFolders') && url.includes('$top') && !url.includes('/messages')) {
      return { ok: true, status: 200, json: async () => ({ value: folders }) };
    }
    // Folder messages
    for (const [folderId, msgs] of Object.entries(folderMessages)) {
      if (url.includes(`/me/mailFolders/${folderId}/messages`)) {
        return { ok: true, status: 200, json: async () => ({ value: msgs }) };
      }
    }
    // Default
    return { ok: true, status: 200, json: async () => ({ value: [] }) };
  };
}

describe('runAgentReport', () => {
  let tmpDir, originalFetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeRules(tmpDir);
    writeAgentConfig(tmpDir);
    writeNotes(tmpDir, '# Agent Notes\n---\n');

    originalFetch = globalThis.fetch;
    _setTokenForTesting('fake-token');
    setRetryDelays([0, 0]);
    setupDefaultGraphMock();

    _setLLMTransportForTesting(async () => defaultLLMResponse());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTokenForTesting(null);
    setRetryDelays([2000, 8000]);
    _setLLMTransportForTesting(null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  // --- Window computation (watermark-based) ---

  describe('window computation', () => {
    test('first run (bootstrap): now minus 24h, returns pending', async () => {
      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      assert.strictEqual(pendings.length, 1);
      // Bootstrap: now - 24h = 2026-07-17T08:30:00.000Z
      assert.strictEqual(pendings[0].window_start, '2026-07-17T08:30:00.000Z');
      // End: now - 15min = 2026-07-18T08:15:00.000Z
      assert.strictEqual(pendings[0].window_end, '2026-07-18T08:15:00.000Z');
      db.close();
    });

    test('normal chain: uses watermark with 10min overlap', async () => {
      // Seed a watermark from a previous run
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.setState('read_watermark', '2026-07-18T06:00:00.000Z');
      db.close();

      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      const db2 = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db2.openPendings();
      assert.strictEqual(pendings.length, 1);
      // Start: watermark - 10min = 2026-07-18T05:50:00.000Z
      assert.strictEqual(pendings[0].window_start, '2026-07-18T05:50:00.000Z');
      // End: now - 15min = 2026-07-18T08:15:00.000Z
      assert.strictEqual(pendings[0].window_end, '2026-07-18T08:15:00.000Z');
      db2.close();
    });

    test('watermark advances to windowEnd after successful assemble', async () => {
      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      assert.strictEqual(db.getState('read_watermark'), '2026-07-18T08:15:00.000Z');
      db.close();
    });

    test('no sort-state.json needed — agent reads independently', async () => {
      // No sort-state.json, no sort DB rows — agent still works
      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      const reportJson = JSON.parse(pendings[0].report_json);
      assert.ok(Array.isArray(reportJson.emails));
      assert.ok(reportJson.sortActivity);
      db.close();
    });
  });

  // --- Watermark atomicity ---

  describe('watermark atomicity', () => {
    test('watermark does not advance if enqueue throws', async () => {
      // Make enqueueCliLLM throw by providing an invalid queue dir path
      // that triggers a write error
      const badQueueDir = path.join(tmpDir, 'nonexistent', 'deep', 'nested', 'llm-queue');
      // Create parent but make the queue dir a file to trigger ENOTDIR
      fs.mkdirSync(path.join(tmpDir, 'nonexistent'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'nonexistent', 'deep'), 'block');

      const o = opts(tmpDir, { _queueDir: badQueueDir });
      try {
        await runAgentReport(o);
        assert.fail('should have thrown');
      } catch { /* expected */ }

      // Watermark should NOT have advanced
      const db = new AgentDB(o._agentDbPath);
      assert.strictEqual(db.getState('read_watermark'), null);
      assert.strictEqual(db.openPendings().length, 0);
      db.close();
    });

    test('seen entries are recorded atomically with watermark', async () => {
      setupFolderMock({
        folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
        folderMessages: {
          'inbox-id': [
            { id: 'msg-1', subject: 'Hello', from: { emailAddress: { address: 'a@test.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-1' },
          ]
        }
      });

      await runAgentReport(opts(tmpDir));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      assert.ok(db.isSeen('inet-1'));
      assert.ok(db.getState('read_watermark'));
      db.close();
    });
  });

  // --- Single-open rule ---

  describe('single-open rule', () => {
    test('rejects new assemble when open pending exists', async () => {
      const r1 = await runAgentReport(opts(tmpDir));
      assert.strictEqual(r1.status, 'pending');

      const r2 = await runAgentReport(opts(tmpDir));
      assert.strictEqual(r2.status, 'single-open');

      const outboxFiles = fs.readdirSync(path.join(tmpDir, 'outbox'));
      assert.ok(outboxFiles.length >= 1);
    });
  });

  // --- Read sweep ---

  describe('read sweep', () => {
    test('multi-folder merge: emails from inbox + custom folder appear in emails[]', async () => {
      setupFolderMock({
        folders: [
          { id: 'inbox-id', displayName: 'Inbox' },
          { id: 'custom-id', displayName: 'Custom' },
        ],
        folderMessages: {
          'inbox-id': [
            { id: 'i1', subject: 'From inbox', from: { emailAddress: { address: 'a@test.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-i1' },
          ],
          'custom-id': [
            { id: 'c1', subject: 'From custom', from: { emailAddress: { address: 'b@test.com' } }, receivedDateTime: '2026-07-18T07:30:00Z', internetMessageId: 'inet-c1' },
          ],
        }
      });

      const result = await runAgentReport(opts(tmpDir));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);
      assert.strictEqual(reportJson.emails.length, 2);
      assert.ok(reportJson.emails.some(e => e.id === 'i1' && e.folder === 'Inbox'));
      assert.ok(reportJson.emails.some(e => e.id === 'c1' && e.folder === 'Custom'));
      db.close();
    });

    test('excluded folders are skipped', async () => {
      setupFolderMock({
        folders: [
          { id: 'inbox-id', displayName: 'Inbox' },
          { id: 'folder-sentitems', displayName: 'Sent Items' },
          { id: 'folder-deleteditems', displayName: 'Deleted Items' },
        ],
        folderMessages: {
          'inbox-id': [
            { id: 'i1', subject: 'Inbox msg', from: { emailAddress: { address: 'a@test.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-i1' },
          ],
          'folder-sentitems': [
            { id: 's1', subject: 'Sent msg', from: { emailAddress: { address: 'me@test.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-s1' },
          ],
        }
      });

      const result = await runAgentReport(opts(tmpDir));
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);
      // Only inbox msg, sent items excluded
      assert.strictEqual(reportJson.emails.length, 1);
      assert.strictEqual(reportJson.emails[0].id, 'i1');
      db.close();
    });

    test('internetMessageId dedupe prevents re-processing across runs', async () => {
      setupFolderMock({
        folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
        folderMessages: {
          'inbox-id': [
            { id: 'msg-A', subject: 'Hello', from: { emailAddress: { address: 'a@test.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-A' },
          ]
        }
      });

      // First run processes the message
      await runAgentReport(opts(tmpDir));

      // Complete the pending so second run can proceed
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.completePending(1, 'done', '2026-07-18T08:35:00Z');
      db.close();

      // Second run: same message but different Graph id (e.g. sort moved it)
      setupFolderMock({
        folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
        folderMessages: {
          'inbox-id': [
            { id: 'msg-A-moved', subject: 'Hello', from: { emailAddress: { address: 'a@test.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-A' },
          ]
        }
      });

      const r2 = await runAgentReport(opts(tmpDir, { _now: '2026-07-18T08:40:00Z' }));
      assert.strictEqual(r2.status, 'pending');

      const db2 = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db2.openPendings();
      const reportJson = JSON.parse(pendings[0].report_json);
      // Message deduped — different Graph id but same internetMessageId
      assert.strictEqual(reportJson.emails.length, 0);
      db2.close();
    });

    test('junked provenance: junk folder emails have junked=true', async () => {
      setupFolderMock({
        folders: [
          { id: 'inbox-id', displayName: 'Inbox' },
          { id: 'folder-junkemail', displayName: 'Junk Email' },
        ],
        folderMessages: {
          'inbox-id': [
            { id: 'i1', subject: 'Normal', from: { emailAddress: { address: 'good@test.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-i1' },
          ],
          'folder-junkemail': [
            { id: 'j1', subject: 'Buy now', from: { emailAddress: { address: 'spam@evil.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-j1' },
          ],
        }
      });

      const result = await runAgentReport(opts(tmpDir));
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);

      const normal = reportJson.emails.find(e => e.id === 'i1');
      assert.strictEqual(normal.junked, false);

      const junk = reportJson.emails.find(e => e.id === 'j1');
      assert.strictEqual(junk.junked, true);
      assert.strictEqual(junk.folder, 'Junk Email');
      db.close();
    });

    test('dismissed junk is excluded', async () => {
      setupFolderMock({
        folders: [{ id: 'folder-junkemail', displayName: 'Junk Email' }],
        folderMessages: {
          'folder-junkemail': [
            { id: 'j-dismissed', subject: 'Old spam', from: { emailAddress: { address: 'old@spam.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-jd' },
            { id: 'j-new', subject: 'New spam', from: { emailAddress: { address: 'new@spam.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-jn' },
          ],
        }
      });

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.dismissJunk('j-dismissed', '2026-07-17T00:00:00Z');
      db.close();

      const result = await runAgentReport(opts(tmpDir));
      const db2 = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db2.openPendings()[0].report_json);

      assert.strictEqual(reportJson.emails.length, 1);
      assert.strictEqual(reportJson.emails[0].id, 'j-new');
      db2.close();
    });

    test('rule-matched unguarded junk auto-rescued (move called)', async () => {
      const moveCalls = [];
      setupFolderMock({
        folders: [{ id: 'folder-junkemail', displayName: 'Junk Email' }],
        folderMessages: {
          'folder-junkemail': [
            { id: 'j-mox', subject: 'Mox tx', from: { emailAddress: { address: 'noreply@mox.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-jm' },
            { id: 'j-unruled', subject: 'Buy now', from: { emailAddress: { address: 'spam@unknown.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-ju' },
          ],
        },
        moveCalls,
      });

      await runAgentReport(opts(tmpDir));

      // Mox should be rescued (unguarded accounting rule)
      assert.strictEqual(moveCalls.length, 1);
      assert.ok(moveCalls[0].includes('j-mox'));

      // Check report — rescued email carries the post-move id from the move
      // response ('moved-new' in the mock), not the dead pre-move id
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);
      const rescuedEmail = reportJson.emails.find(e => e.id === 'moved-new');
      assert.ok(rescuedEmail, 'rescued email present under post-move id');
      assert.strictEqual(rescuedEmail.rescued, true);
      assert.strictEqual(rescuedEmail.junked, true);

      // Unruled stays as pending junk
      const unruledEmail = reportJson.emails.find(e => e.id === 'j-unruled');
      assert.strictEqual(unruledEmail.junked, true);
      assert.ok(!unruledEmail.rescued);

      // Compat junk array
      assert.ok(reportJson.junk.some(j => j.id === 'moved-new' && j.flag === 'rescued-rule'));
      assert.ok(reportJson.junk.some(j => j.id === 'j-unruled' && j.flag === 'pending'));
      db.close();
    });

    test('guarded junk rule match stays in junk (not rescued)', async () => {
      const moveCalls = [];
      setupFolderMock({
        folders: [{ id: 'folder-junkemail', displayName: 'Junk Email' }],
        folderMessages: {
          'folder-junkemail': [
            { id: 'j-guard', subject: 'urgent: GitHub alert', from: { emailAddress: { address: 'noreply@github.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-jg' },
          ],
        },
        moveCalls,
      });

      await runAgentReport(opts(tmpDir));

      // No move — guarded
      assert.strictEqual(moveCalls.length, 0);

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);
      const email = reportJson.emails[0];
      assert.strictEqual(email.junked, true);
      assert.ok(!email.rescued);
      assert.strictEqual(email.classify.guarded, true);
      db.close();
    });

    test('bootstrap window: 24h lookback on first run', async () => {
      const result = await runAgentReport(opts(tmpDir));
      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      // now = 2026-07-18T08:30:00Z, start = now - 24h
      assert.strictEqual(pendings[0].window_start, '2026-07-17T08:30:00.000Z');
      db.close();
    });

    test('folder list failure throws — nothing read means nothing consumed', async () => {
      // Make folder listing fail
      globalThis.fetch = async (url) => {
        const wkMatch = url.match(/\/me\/mailFolders\/(sentitems|deleteditems|drafts|outbox|junkemail)\b/);
        if (wkMatch && !url.includes('/messages')) {
          return { ok: true, status: 200, json: async () => ({ id: `folder-${wkMatch[1]}` }) };
        }
        if (url.includes('/me/mailFolders') && url.includes('$top')) {
          throw new Error('Graph API down');
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      };

      await assert.rejects(() => runAgentReport(opts(tmpDir)));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      assert.strictEqual(db.getState('read_watermark'), null);
      assert.strictEqual(db.openPendings().length, 0);
      db.close();
    });
  });

  // --- Dry classify attribution ---

  describe('dry classify attribution', () => {
    test('non-junk emails carry classify attribution', async () => {
      setupFolderMock({
        folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
        folderMessages: {
          'inbox-id': [
            { id: 'ruled-1', subject: 'PR merged', from: { emailAddress: { address: 'noreply@github.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-r1' },
            { id: 'unruled-1', subject: 'Hello', from: { emailAddress: { address: 'hello@newco.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-u1' },
          ]
        }
      });

      await runAgentReport(opts(tmpDir));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);

      const ruled = reportJson.emails.find(e => e.id === 'ruled-1');
      assert.deepStrictEqual(ruled.classify, { bucket: 'notifications', ruleId: 'github-notif', guarded: false });

      const unruled = reportJson.emails.find(e => e.id === 'unruled-1');
      assert.strictEqual(unruled.classify, null);
      db.close();
    });
  });

  // --- Body fetch ---

  describe('body fetch', () => {
    test('priority: junk pending before unruled before ruled', async () => {
      const bodyFetched = [];
      globalThis.fetch = async (url, fetchOpts) => {
        // Track body fetches
        const bodyMatch = url.match(/\/me\/messages\/([^?/]+)\?.*\$select=body/);
        if (bodyMatch) {
          bodyFetched.push(bodyMatch[1]);
          return { ok: true, status: 200, json: async () => ({ body: { content: `body-${bodyMatch[1]}`, contentType: 'text' } }) };
        }
        if (fetchOpts?.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ id: 'moved' }) };
        }
        const wkMatch = url.match(/\/me\/mailFolders\/(sentitems|deleteditems|drafts|outbox|junkemail)\b/);
        if (wkMatch && !url.includes('/messages')) {
          return { ok: true, status: 200, json: async () => ({ id: `folder-${wkMatch[1]}` }) };
        }
        if (url.includes('/me/mailFolders') && url.includes('$top') && !url.includes('/messages')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              value: [
                { id: 'inbox-id', displayName: 'Inbox' },
                { id: 'folder-junkemail', displayName: 'Junk Email' },
              ]
            })
          };
        }
        if (url.includes('folder-junkemail/messages')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              value: [
                { id: 'junk-1', subject: 'Junk', from: { emailAddress: { address: 'spam@evil.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-j1' },
              ]
            })
          };
        }
        if (url.includes('inbox-id/messages')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              value: [
                { id: 'ruled-1', subject: 'GH', from: { emailAddress: { address: 'x@github.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-r1' },
                { id: 'unruled-1', subject: 'New', from: { emailAddress: { address: 'y@newco.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-u1' },
              ]
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      };

      await runAgentReport(opts(tmpDir));

      // Order: junk-1 (junk pending), then unruled-1, then ruled-1
      assert.strictEqual(bodyFetched[0], 'junk-1');
      assert.strictEqual(bodyFetched[1], 'unruled-1');
      assert.strictEqual(bodyFetched[2], 'ruled-1');
    });

    test('overflow: cap exceeded reports bodyOverflow count', async () => {
      // Create many emails exceeding cap
      const msgs = [];
      for (let i = 0; i < 5; i++) {
        msgs.push({
          id: `msg-${i}`, subject: `Email ${i}`,
          from: { emailAddress: { address: `u${i}@test.com` } },
          receivedDateTime: `2026-07-18T0${7 + i % 3}:00:00Z`,
          internetMessageId: `inet-${i}`
        });
      }

      setupFolderMock({
        folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
        folderMessages: { 'inbox-id': msgs }
      });

      // Set cap to 3
      const cfgPath = path.join(tmpDir, 'agent.json');
      fs.writeFileSync(cfgPath, JSON.stringify({ model: 'claude-sonnet-5', readBodyCap: 3 }));

      await runAgentReport(opts(tmpDir));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);
      assert.strictEqual(reportJson.bodyOverflow, 2);
      // 3 emails should have body_excerpt, 2 should not
      const withBody = reportJson.emails.filter(e => e.body_excerpt);
      assert.strictEqual(withBody.length, 3);
      db.close();
    });

    test('bodyOverflow omitted when all bodies fetched', async () => {
      setupFolderMock({
        folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
        folderMessages: {
          'inbox-id': [
            { id: 'msg-1', subject: 'A', from: { emailAddress: { address: 'a@test.com' } }, receivedDateTime: '2026-07-18T07:00:00Z', internetMessageId: 'inet-1' },
          ]
        }
      });

      await runAgentReport(opts(tmpDir));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);
      assert.strictEqual(reportJson.bodyOverflow, undefined);
      db.close();
    });
  });

  // --- Reminders ---

  describe('reminders', () => {
    test('creates reminders for reminder-class rules only', async () => {
      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'toll-001',
          sender: 'noreply@govhk.com', domain: 'govhk.com',
          subject: 'Toll payment due', subject_key: 'toll payment due',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'hketoll-reminder', action: 'moved', parsed: null
        },
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'gh-001',
          sender: 'noreply@github.com', domain: 'github.com',
          subject: 'PR merged', subject_key: 'pr merged',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'github-notif', action: 'moved', parsed: null
        }
      ]);

      await runAgentReport(opts(tmpDir));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reminders = db.openReminders();
      assert.strictEqual(reminders.length, 1);
      assert.strictEqual(reminders[0].kind, 'hketoll-reminder');
      assert.strictEqual(reminders[0].source_email_id, 'toll-001');
      db.close();
    });

    test('deduplicates reminders on re-run', async () => {
      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'toll-001',
          sender: 'noreply@govhk.com', domain: 'govhk.com',
          subject: 'Toll payment due', subject_key: 'toll payment due',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'hketoll-reminder', action: 'moved', parsed: null
        }
      ]);

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      db.addReminder({ kind: 'hketoll-reminder', source_email_id: 'toll-001', subject: 'dup', now: '2026-07-18T09:00:00Z' });
      const reminders = db.openReminders();
      assert.strictEqual(reminders.length, 1);
      db.close();
    });
  });

  // --- Sort activity ---

  describe('sort activity', () => {
    test('groups moved rows into sortActivity', async () => {
      const dbPath = path.join(tmpDir, 'transactions.db');
      insertSortRows(dbPath, [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'gh-1',
          sender: 'x@github.com', domain: 'github.com',
          subject: 'PR 1', subject_key: 'pr #',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'github-notif', action: 'moved', parsed: null
        },
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'gh-2',
          sender: 'x@github.com', domain: 'github.com',
          subject: 'PR 2', subject_key: 'pr #',
          received_at: '2026-07-17T09:30:00Z', bucket: 'notifications',
          rule_id: 'github-notif', action: 'moved', parsed: null
        },
      ]);

      await runAgentReport(opts(tmpDir));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      const reportJson = JSON.parse(pendings[0].report_json);
      assert.strictEqual(reportJson.sortActivity.moved.length, 1);
      assert.strictEqual(reportJson.sortActivity.moved[0].ruleId, 'github-notif');
      assert.strictEqual(reportJson.sortActivity.moved[0].count, 2);
      db.close();
    });
  });

  // --- Dry mode ---

  describe('dry mode', () => {
    test('zero mutations: no outbox, no DB writes, no graph moves, no watermark', async () => {
      const moveCalls = [];
      setupFolderMock({
        folders: [
          { id: 'inbox-id', displayName: 'Inbox' },
          { id: 'folder-junkemail', displayName: 'Junk Email' },
        ],
        folderMessages: {
          'inbox-id': [],
          'folder-junkemail': [
            { id: 'j-mox-dry', subject: 'Mox tx', from: { emailAddress: { address: 'a@mox.com' } }, receivedDateTime: '2026-07-18T06:00:00Z', internetMessageId: 'inet-jmd' },
          ],
        },
        moveCalls,
      });

      insertSortRows(path.join(tmpDir, 'transactions.db'), [
        {
          run_at: '2026-07-17T10:00:00Z', email_id: 'toll-dry',
          sender: 'noreply@govhk.com', domain: 'govhk.com',
          subject: 'Toll', subject_key: 'toll',
          received_at: '2026-07-17T09:00:00Z', bucket: 'notifications',
          rule_id: 'hketoll-reminder', action: 'moved', parsed: null
        }
      ]);

      _setLLMTransportForTesting(async () => ({
        message_text: 'Dry report',
        new_questions: [{ domain: 'test', question: 'Q?' }],
        auto_resolved_reminders: [],
        junk_flags: []
      }));

      const o = opts(tmpDir, { dry: true });
      const result = await runAgentReport(o);
      assert.strictEqual(result.status, 'ok');

      // No outbox
      assert.ok(!fs.existsSync(o._outboxDir));

      // No graph moves
      assert.strictEqual(moveCalls.length, 0);

      // No DB mutations
      const db = new AgentDB(o._agentDbPath);
      assert.strictEqual(db.openReminders().length, 0);
      assert.strictEqual(db.openQuestions().length, 0);
      assert.strictEqual(db.getState('read_watermark'), null);
      assert.strictEqual(db.openPendings().length, 0);
      db.close();
    });

    test('LLM failure in dry mode produces degraded template', async () => {
      _setLLMTransportForTesting(async () => { throw new Error('API down'); });

      const result = await runAgentReport(opts(tmpDir, { dry: true }));
      assert.strictEqual(result.status, 'degraded');
      assert.ok(result.message.includes('[degraded]'));
      assert.ok(result.message.includes('sort:'));
    });
  });

  // --- Notes warning ---

  describe('notes warning', () => {
    test('notes >60 lines appends warning to message (dry)', async () => {
      const lines = Array(65).fill('line').join('\n');
      writeNotes(tmpDir, lines);

      const result = await runAgentReport(opts(tmpDir, { dry: true }));
      assert.ok(result.message.includes('agent-notes.md 有 65 行，清理時間'));
    });

    test('notes <=60 lines: no warning (dry)', async () => {
      writeNotes(tmpDir, Array(60).fill('line').join('\n'));

      const result = await runAgentReport(opts(tmpDir, { dry: true }));
      assert.ok(!result.message.includes('agent-notes.md'));
    });
  });

  // --- Report JSON contract ---

  describe('report JSON contract', () => {
    test('has required top-level keys', async () => {
      await runAgentReport(opts(tmpDir));

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const reportJson = JSON.parse(db.openPendings()[0].report_json);

      assert.ok(reportJson.window);
      assert.ok(reportJson.window.start);
      assert.ok(reportJson.window.end);
      assert.ok(Array.isArray(reportJson.emails));
      assert.ok(reportJson.sortActivity);
      assert.ok(reportJson.sortActivity.summary);
      assert.ok(Array.isArray(reportJson.reminders));
      assert.ok(Array.isArray(reportJson.questions));
      assert.ok(Array.isArray(reportJson.junk)); // compat
      db.close();
    });
  });

  // --- Enqueue ---

  describe('enqueue', () => {
    test('non-dry creates request file in queue dir', async () => {
      const o = opts(tmpDir);
      const result = await runAgentReport(o);

      assert.strictEqual(result.status, 'pending');
      const reqDir = path.join(o._queueDir, 'requests');
      const files = fs.readdirSync(reqDir).filter(f => f.endsWith('.json'));
      assert.strictEqual(files.length, 1);
    });

    test('origin defaults to check, can be set to idle', async () => {
      const result = await runAgentReport(opts(tmpDir, { origin: 'idle' }));
      assert.strictEqual(result.status, 'pending');

      const db = new AgentDB(path.join(tmpDir, 'agent.db'));
      const pendings = db.openPendings();
      assert.strictEqual(pendings[0].origin, 'idle');
      db.close();
    });
  });
});

// --- buildDegradedMessage ---

describe('buildDegradedMessage', () => {
  test('includes email subjects from emails[] (cap 15)', () => {
    const reportJson = {
      window: { start: '2026-07-17T08:00:00Z', end: '2026-07-18T08:00:00Z' },
      emails: [
        { id: 'e1', sender: 'a@example.com', domain: 'example.com', subject: 'Hello World', received: '2026-07-18T08:00:00Z', folder: 'Inbox', junked: false, classify: null },
        { id: 'e2', sender: 'b@test.com', domain: 'test.com', subject: 'Test email', received: '2026-07-18T08:00:00Z', folder: 'Inbox', junked: false, classify: null },
      ],
      sortActivity: {
        moved: [{ ruleId: 'test', count: 2 }],
        guardBlocked: [],
        summary: { keptRuleCount: 0, pinnedCount: 0 }
      },
      reminders: [],
      questions: [],
      junk: [],
    };

    const msg = buildDegradedMessage(reportJson);
    assert.ok(msg.includes('[degraded]'));
    assert.ok(msg.includes('Hello World (a@example.com)'));
    assert.ok(msg.includes('Test email (b@test.com)'));
    assert.ok(msg.includes('LLM 唔喺度'));
  });

  test('caps at 15 subjects with +N more', () => {
    const emails = [];
    for (let i = 0; i < 20; i++) {
      emails.push({
        id: `e${i}`, sender: `u${i}@test.com`, domain: 'test.com',
        subject: `Subject ${i}`, received: '2026-07-18T08:00:00Z',
        folder: 'Inbox', junked: false, classify: null
      });
    }
    const reportJson = {
      emails,
      sortActivity: { moved: [], guardBlocked: [], summary: { keptRuleCount: 0, pinnedCount: 0 } },
      reminders: [],
      questions: [],
      junk: [],
    };

    const msg = buildDegradedMessage(reportJson);
    assert.ok(msg.includes('Subject 0'));
    assert.ok(msg.includes('Subject 14'));
    assert.ok(!msg.includes('Subject 15'));
    assert.ok(msg.includes('+5 more'));
  });

  test('rescued junk excluded from subject list', () => {
    const reportJson = {
      emails: [
        { id: 'j1', sender: 'a@mox.com', subject: 'Rescued', junked: true, rescued: true, classify: { bucket: 'accounting' }, folder: 'Junk', received: '2026-07-18T08:00:00Z', domain: 'mox.com' },
        { id: 'e1', sender: 'b@test.com', subject: 'Normal', junked: false, classify: null, folder: 'Inbox', received: '2026-07-18T08:00:00Z', domain: 'test.com' },
      ],
      sortActivity: { moved: [], guardBlocked: [], summary: { keptRuleCount: 0, pinnedCount: 0 } },
      reminders: [],
      questions: [],
      junk: [],
    };

    const msg = buildDegradedMessage(reportJson);
    assert.ok(!msg.includes('Rescued'));
    assert.ok(msg.includes('Normal'));
  });
});

describe('scan failure semantics (completeness clause)', () => {
  let tmpDir, originalFetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeRules(tmpDir);
    writeAgentConfig(tmpDir);
    writeNotes(tmpDir, '# Agent Notes\n---\n');
    originalFetch = globalThis.fetch;
    _setTokenForTesting('fake-token');
    setRetryDelays([0, 0]);
    _setLLMTransportForTesting(async () => defaultLLMResponse());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _setTokenForTesting(null);
    setRetryDelays([2000, 8000]);
    _setLLMTransportForTesting(null);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('per-folder failure: watermark stays, scanIncomplete recorded, other folders still read', async () => {
    globalThis.fetch = async (url, fetchOpts) => {
      const wkMatch = url.match(/\/me\/mailFolders\/(sentitems|deleteditems|drafts|outbox|junkemail)\b/);
      if (wkMatch && !url.includes('/messages')) {
        return { ok: true, status: 200, json: async () => ({ id: `folder-${wkMatch[1]}` }) };
      }
      if (url.includes('/me/mailFolders') && url.includes('$top') && !url.includes('/messages')) {
        return { ok: true, status: 200, json: async () => ({ value: [
          { id: 'f-ok', displayName: 'Inbox' },
          { id: 'f-bad', displayName: 'Broken' },
        ] }) };
      }
      if (url.includes('/me/mailFolders/f-ok/messages')) {
        return { ok: true, status: 200, json: async () => ({ value: [
          { id: 'm1', internetMessageId: '<im-1@x>', subject: 'Hello', receivedDateTime: '2026-07-18T08:00:00Z',
            from: { emailAddress: { address: 'a@example.com' } } }
        ] }) };
      }
      if (url.includes('/me/mailFolders/f-bad/messages')) {
        return { ok: false, status: 403, json: async () => ({ error: { message: 'forbidden' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [], body: { content: 'b', contentType: 'text' } }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    assert.strictEqual(result.status, 'pending');

    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    // Watermark must NOT advance — Broken folder holds unread mail
    assert.strictEqual(db.getState('read_watermark'), null);
    // Seen entry recorded for the email that WAS read
    assert.strictEqual(db.isSeen('<im-1@x>'), true);
    const pending = db.openPendings()[0];
    const rj = JSON.parse(pending.report_json);
    assert.deepStrictEqual(rj.scanIncomplete, ['Broken']);
    assert.strictEqual(rj.emails.length, 1);
    assert.strictEqual(rj.emails[0].subject, 'Hello');
    db.close();
  });

  test('folder list failure: assemble throws, nothing consumed', async () => {
    globalThis.fetch = async (url) => {
      const wkMatch = url.match(/\/me\/mailFolders\/(sentitems|deleteditems|drafts|outbox|junkemail)\b/);
      if (wkMatch && !url.includes('/messages')) {
        return { ok: true, status: 200, json: async () => ({ id: `folder-${wkMatch[1]}` }) };
      }
      if (url.includes('/me/mailFolders') && url.includes('$top') && !url.includes('/messages')) {
        return { ok: false, status: 403, json: async () => ({ error: { message: 'forbidden' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }) };
    };

    await assert.rejects(() => runAgentReport(opts(tmpDir)));

    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    assert.strictEqual(db.getState('read_watermark'), null);
    assert.strictEqual(db.openPendings().length, 0);
    db.close();
  });

  test('rescued junk carries the post-move Graph id', async () => {
    globalThis.fetch = async (url, fetchOpts) => {
      if (fetchOpts?.method === 'POST' && url.includes('/move')) {
        return { ok: true, status: 200, json: async () => ({ id: 'post-move-id' }) };
      }
      const wkMatch = url.match(/\/me\/mailFolders\/(sentitems|deleteditems|drafts|outbox|junkemail)\b/);
      if (wkMatch && !url.includes('/messages')) {
        return { ok: true, status: 200, json: async () => ({ id: `folder-${wkMatch[1]}` }) };
      }
      if (url.includes('/me/mailFolders') && url.includes('$top') && !url.includes('/messages')) {
        return { ok: true, status: 200, json: async () => ({ value: [
          { id: 'folder-junkemail', displayName: 'Junk Email' },
        ] }) };
      }
      if (url.includes('/me/mailFolders/folder-junkemail/messages')) {
        return { ok: true, status: 200, json: async () => ({ value: [
          { id: 'junk-old-id', internetMessageId: '<im-junk@x>', subject: 'Mox alert',
            receivedDateTime: '2026-07-18T08:00:00Z',
            from: { emailAddress: { address: 'noreply@mox.com' } } }
        ] }) };
      }
      return { ok: true, status: 200, json: async () => ({ value: [], body: { content: 'b', contentType: 'text' } }) };
    };

    const result = await runAgentReport(opts(tmpDir));
    assert.strictEqual(result.status, 'pending');

    const db = new AgentDB(path.join(tmpDir, 'agent.db'));
    const rj = JSON.parse(db.openPendings()[0].report_json);
    const rescued = rj.emails.find(e => e.rescued);
    assert.ok(rescued, 'rescued email present');
    assert.strictEqual(rescued.id, 'post-move-id');
    const compat = rj.junk.find(j => j.flag === 'rescued-rule');
    assert.strictEqual(compat.id, 'post-move-id');
    db.close();
  });
});
