import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { computeWindow } from '../src/sorter/sort.js';
import { loadRules } from '../src/sorter/rules.js';
import { addRule, removeRule, addGuard, removeGuard } from '../src/commands/rule.js';

describe('computeWindow', () => {
  test('--since overrides state, end = now - minAgeHours', () => {
    const result = computeWindow({
      state: { processedThrough: '2026-07-12T10:00:00Z' },
      since: '2026-07-01',
      now: '2026-07-13T12:00:00Z',
      minAgeHours: 6
    });
    assert.strictEqual(result.start, '2026-07-01T00:00:00Z');
    assert.strictEqual(result.end, new Date('2026-07-13T06:00:00Z').toISOString());
    assert.strictEqual(result.initialize, undefined);
  });

  test('since with T is passed through, end respects minAgeHours', () => {
    const result = computeWindow({
      state: null,
      since: '2026-07-01T05:30:00Z',
      now: '2026-07-13T12:00:00Z',
      minAgeHours: 6
    });
    assert.strictEqual(result.start, '2026-07-01T05:30:00Z');
    assert.strictEqual(result.end, new Date('2026-07-13T06:00:00Z').toISOString());
  });

  test('state.processedThrough minus 1h becomes start, end = now - minAgeHours', () => {
    const result = computeWindow({
      state: { processedThrough: '2026-07-13T10:00:00Z' },
      since: null,
      now: '2026-07-13T18:00:00Z',
      minAgeHours: 6
    });
    assert.strictEqual(result.start, '2026-07-13T09:00:00.000Z');
    assert.strictEqual(result.end, new Date('2026-07-13T12:00:00Z').toISOString());
  });

  test('no since + no state → initialize', () => {
    const result = computeWindow({
      state: null,
      since: null,
      now: '2026-07-13T12:00:00Z',
      minAgeHours: 6
    });
    assert.strictEqual(result.initialize, true);
    assert.strictEqual(result.start, undefined);
  });

  test('tooSoon when watermark-derived start >= end', () => {
    // processedThrough = T+10, start = T+9 (minus 1h overlap)
    // now = T+12, minAgeHours=6, end = T+6
    // start(T+9) >= end(T+6) → tooSoon
    const result = computeWindow({
      state: { processedThrough: '2026-07-13T10:00:00Z' },
      since: null,
      now: '2026-07-13T12:00:00Z',
      minAgeHours: 6
    });
    assert.strictEqual(result.tooSoon, true);
  });

  test('THE GAP TEST: consecutive runs 4h apart cover all emails, no gap', () => {
    // Run 1: at T=18:00, minAgeHours=6
    // State before run1: processedThrough = T-10h = 08:00
    // Run1 window: start = 08:00-1h = 07:00, end = 18:00-6h = 12:00
    // After run1: state.processedThrough = 12:00 (the end cutoff)
    const run1 = computeWindow({
      state: { processedThrough: '2026-07-13T08:00:00Z' },
      since: null,
      now: '2026-07-13T18:00:00Z',
      minAgeHours: 6
    });
    assert.strictEqual(run1.start, '2026-07-13T07:00:00.000Z');
    assert.strictEqual(run1.end, new Date('2026-07-13T12:00:00Z').toISOString());

    // Run 2: 4h later at T=22:00, state.processedThrough = run1.end = 12:00
    // Run2 window: start = 12:00-1h = 11:00, end = 22:00-6h = 16:00
    const run2 = computeWindow({
      state: { processedThrough: run1.end },
      since: null,
      now: '2026-07-13T22:00:00Z',
      minAgeHours: 6
    });
    assert.strictEqual(run2.start, '2026-07-13T11:00:00.000Z');
    assert.strictEqual(run2.end, new Date('2026-07-13T16:00:00Z').toISOString());

    // KEY ASSERTION: run2 start (11:00) <= run1 end (12:00)
    // This guarantees no gap — anything received between run1.end and run2.end
    // is within [run2.start, run2.end], so nothing falls through.
    assert.ok(
      new Date(run2.start) <= new Date(run1.end),
      `run2.start (${run2.start}) must be <= run1.end (${run1.end}) to prevent gaps`
    );
  });

  test('minAge 0 → end equals now', () => {
    const now = '2026-07-13T12:00:00Z';
    const result = computeWindow({
      state: { processedThrough: '2026-07-13T08:00:00Z' },
      since: null,
      now,
      minAgeHours: 0
    });
    assert.strictEqual(result.end, new Date(now).toISOString());
  });
});

describe('loadRules settings', () => {
  const tmpDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
  const tmpFile = path.join(tmpDir, '.test-rules-settings.json');

  function writeConfig(obj) {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(obj));
  }

  function cleanup() {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  test('default minAgeHours is 6 when settings absent', () => {
    writeConfig({ version: 1, guards: [], rules: [] });
    try {
      const config = loadRules(tmpFile);
      assert.strictEqual(config.settings.minAgeHours, 6);
    } finally { cleanup(); }
  });

  test('custom minAgeHours value is honored', () => {
    writeConfig({ version: 1, guards: [], rules: [], settings: { minAgeHours: 12 } });
    try {
      const config = loadRules(tmpFile);
      assert.strictEqual(config.settings.minAgeHours, 12);
    } finally { cleanup(); }
  });

  test('minAgeHours 0 is valid', () => {
    writeConfig({ version: 1, guards: [], rules: [], settings: { minAgeHours: 0 } });
    try {
      const config = loadRules(tmpFile);
      assert.strictEqual(config.settings.minAgeHours, 0);
    } finally { cleanup(); }
  });

  test('negative minAgeHours throws', () => {
    writeConfig({ version: 1, guards: [], rules: [], settings: { minAgeHours: -1 } });
    try {
      assert.throws(() => loadRules(tmpFile), /non-negative finite number/);
    } finally { cleanup(); }
  });

  test('non-number minAgeHours throws', () => {
    writeConfig({ version: 1, guards: [], rules: [], settings: { minAgeHours: 'six' } });
    try {
      assert.throws(() => loadRules(tmpFile), /non-negative finite number/);
    } finally { cleanup(); }
  });

  test('Infinity minAgeHours throws', () => {
    writeConfig({ version: 1, guards: [], rules: [], settings: { minAgeHours: Infinity } });
    try {
      assert.throws(() => loadRules(tmpFile), /non-negative finite number/);
    } finally { cleanup(); }
  });
});

describe('rule mutations (pure functions)', () => {
  const baseConfig = {
    version: 1,
    guards: ['failed', 'declined'],
    rules: [
      { id: 'mox-tx', bucket: 'accounting', domains: ['mox.com'], subject: '交易' }
    ]
  };

  test('addRule generates id from first domain', () => {
    const { config, id } = addRule(baseConfig, {
      bucket: 'notifications',
      domains: ['test.com'],
      subject: null,
      note: null
    });
    assert.strictEqual(id, 'test-com');
    assert.strictEqual(config.rules.length, 2);
    assert.strictEqual(config.rules[1].bucket, 'notifications');
    assert.ok(config.rules[1].added);
    assert.ok(config.rules[1].probationUntil);
  });

  test('addRule deduplicates id with -2 suffix', () => {
    const config = {
      ...baseConfig,
      rules: [
        ...baseConfig.rules,
        { id: 'test-com', bucket: 'notifications', domains: ['test.com'] }
      ]
    };
    const { id } = addRule(config, {
      bucket: 'notifications',
      domains: ['test.com'],
      subject: null,
      note: null
    });
    assert.strictEqual(id, 'test-com-2');
  });

  test('removeRule removes by id', () => {
    const config = removeRule(baseConfig, 'mox-tx');
    assert.strictEqual(config.rules.length, 0);
  });

  test('removeRule throws on missing id', () => {
    assert.throws(() => removeRule(baseConfig, 'nonexistent'), /not found/);
  });

  test('addGuard adds lowercase', () => {
    const config = addGuard(baseConfig, 'OVERDUE');
    assert.ok(config.guards.includes('overdue'));
    assert.strictEqual(config.guards.length, 3);
  });

  test('addGuard throws on duplicate', () => {
    assert.throws(() => addGuard(baseConfig, 'failed'), /already exists/);
  });

  test('removeGuard removes', () => {
    const config = removeGuard(baseConfig, 'failed');
    assert.strictEqual(config.guards.length, 1);
    assert.ok(!config.guards.includes('failed'));
  });

  test('removeGuard throws on missing', () => {
    assert.throws(() => removeGuard(baseConfig, 'xyz'), /not found/);
  });

  test('addRule with ignoreGuards flag lands in entry', () => {
    const { config } = addRule(baseConfig, {
      bucket: 'notifications',
      domains: ['fail.com'],
      subject: '還款失敗',
      subjectExclude: null,
      ignoreGuards: true,
      note: null
    });
    const added = config.rules[config.rules.length - 1];
    assert.strictEqual(added.ignoreGuards, true);
  });

  test('addRule with subjectExclude lands in entry', () => {
    const { config } = addRule(baseConfig, {
      bucket: 'accounting',
      domains: ['bank.com'],
      subject: '交易',
      subjectExclude: '被拒',
      ignoreGuards: false,
      note: null
    });
    const added = config.rules[config.rules.length - 1];
    assert.strictEqual(added.subjectExclude, '被拒');
    assert.strictEqual(added.ignoreGuards, undefined);
  });

  test('addRule without new fields omits them from entry', () => {
    const { config } = addRule(baseConfig, {
      bucket: 'notifications',
      domains: ['plain.com'],
      subject: null,
      subjectExclude: null,
      ignoreGuards: false,
      note: null
    });
    const added = config.rules[config.rules.length - 1];
    assert.strictEqual(added.subjectExclude, undefined);
    assert.strictEqual(added.ignoreGuards, undefined);
  });
});
