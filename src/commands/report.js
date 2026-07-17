import { graphGet, buildGraphUrl } from '../graph.js';
import { loadRules, classify, subjectKey } from '../sorter/rules.js';
import { SortLogDB } from '../sorter/db.js';
import { computeWindow } from '../sorter/sort.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'transactions.db');
const STATE_PATH = path.join(__dirname, '..', '..', 'data', 'sort-state.json');

export function groupMoved(rows, config, now = new Date().toISOString()) {
  const today = now.slice(0, 10);
  const byRule = new Map();
  for (const r of rows) {
    if (r.action !== 'moved') continue;
    if (!byRule.has(r.rule_id)) {
      const rule = config.rules.find(x => x.id === r.rule_id);
      const probationActive = rule?.probationUntil && rule.probationUntil >= today;
      byRule.set(r.rule_id, {
        ruleId: r.rule_id,
        bucket: r.bucket,
        count: 0,
        probation: probationActive ? rule.probationUntil : null,
        subjects: [],
        noveltySubjects: [],
        _rows: []
      });
    }
    const g = byRule.get(r.rule_id);
    g.count++;
    g._rows.push(r);
    if (g.probation) g.subjects.push(r.subject);
  }
  return [...byRule.values()];
}

export function groupKept(rows) {
  const byDomain = new Map();
  for (const r of rows) {
    if (r.action !== 'kept') continue;
    if (!byDomain.has(r.domain)) {
      byDomain.set(r.domain, { domain: r.domain, count: 0, samples: [] });
    }
    const g = byDomain.get(r.domain);
    g.count++;
    if (g.samples.length < 3) {
      g.samples.push({ subject: r.subject, received: r.received_at });
    }
  }
  return [...byDomain.values()].sort((a, b) => b.count - a.count);
}

export function markNovelty(groups, logDb, windowStart) {
  for (const g of groups) {
    if (g.probation) continue;
    // Skip novelty for rules with no pre-window history (bootstrap gate)
    if (!logDb.ruleHasMovedBefore(g.ruleId, windowStart)) continue;
    // Check each unique subject_key for novelty
    const seen = new Set();
    for (const row of g._rows || []) {
      const sk = row.subject_key;
      if (seen.has(sk)) continue;
      seen.add(sk);
      if (logDb.isNovelSubject(g.ruleId, sk, windowStart)) {
        g.noveltySubjects.push(row.subject);
      }
    }
  }
}

function stripInternal(groups) {
  for (const g of groups) delete g._rows;
  return groups;
}

async function liveClassify(config, since) {
  const params = {
    top: 100,
    orderby: 'receivedDateTime desc',
    select: 'id,subject,from,receivedDateTime,isRead',
    filter: `receivedDateTime ge ${since}`
  };
  const url = buildGraphUrl('/me/mailFolders/inbox/messages', params);
  let result = await graphGet(url);
  let messages = [...result.value];
  while (result['@odata.nextLink']) {
    result = await graphGet(result['@odata.nextLink']);
    messages.push(...result.value);
  }

  const rows = messages.map(msg => {
    const senderAddr = msg.from?.emailAddress?.address || '';
    const subject = msg.subject || '';
    const domain = senderAddr.toLowerCase().split('@').pop() || '';
    const r = classify(senderAddr, subject, config);
    return {
      email_id: msg.id,
      sender: senderAddr,
      domain,
      subject,
      subject_key: subjectKey(subject),
      received_at: msg.receivedDateTime,
      bucket: r.bucket,
      rule_id: r.ruleId || null,
      action: r.bucket ? (r.guarded ? 'guard-blocked' : (r.bucket === 'keep' ? 'kept-rule' : 'moved')) : 'kept',
      parsed: null
    };
  });
  return rows;
}

export async function reportCommand(options) {
  const hours = parseInt(options.hours) || 24;
  const config = loadRules();
  const json = options.json || false;
  const live = options.live || false;

  let since;
  if (options.since) {
    since = options.since.includes('T') ? options.since : `${options.since}T00:00:00Z`;
  } else {
    const d = new Date();
    d.setHours(d.getHours() - hours);
    since = d.toISOString();
  }

  let rows;
  let simulated = false;
  const logDb = new SortLogDB(DB_PATH);

  if (live) {
    rows = await liveClassify(config, since);
    simulated = true;
  } else {
    rows = logDb.db.prepare('SELECT * FROM sort_log WHERE run_at >= ?').all(since);
  }

  const moved = groupMoved(rows, config);
  markNovelty(moved, logDb, since);
  stripInternal(moved);
  const guardBlocked = rows.filter(r => r.action === 'guard-blocked');
  const noparse = rows.filter(r => r.action === 'moved' && r.parsed === 0);
  const unsorted = rows.filter(r => r.action === 'unsorted');
  const runErrors = rows.filter(r => r.action === 'run-error');
  const kept = groupKept(rows);
  for (const g of kept) g.historicalCount = logDb.domainHistory(g.domain);
  logDb.close();

  const report = { simulated, moved, guardBlocked, noparse, unsorted, runErrors, kept };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  // Text output
  console.log(`Report since ${since}${simulated ? ' (simulated)' : ''}\n`);

  if (moved.length > 0) {
    console.log('Moved:');
    for (const g of moved) {
      const prob = g.probation ? ' [PROBATION]' : '';
      console.log(`  ${g.ruleId} [${g.bucket}]: ${g.count}${prob}`);
      if (g.probation && g.subjects.length > 0) {
        for (const s of g.subjects) console.log(`    - ${s}`);
      }
      if (g.noveltySubjects.length > 0) {
        console.log('    Novel subjects:');
        for (const s of g.noveltySubjects) console.log(`      - ${s}`);
      }
    }
  }

  if (guardBlocked.length > 0) {
    console.log('\nGuard-blocked:');
    for (const r of guardBlocked) console.log(`  ${r.sender} — ${r.subject}`);
  }

  if (noparse.length > 0) {
    console.log('\nNo parse (accounting, moved but no transaction extracted):');
    for (const r of noparse) console.log(`  ${r.sender} — ${r.subject}`);
  }

  if (unsorted.length > 0) {
    console.log('\nUnsorted (moved back to inbox):');
    for (const r of unsorted) console.log(`  ${r.sender} — ${r.subject}`);
  }

  if (runErrors.length > 0) {
    console.log('\nRun errors:');
    for (const r of runErrors) console.log(`  ${r.run_at} — ${r.subject}`);
  }

  if (kept.length > 0) {
    console.log('\nKept in inbox:');
    for (const g of kept) {
      const hist = g.historicalCount > g.count ? ` (all-time kept: ${g.historicalCount})` : '';
      console.log(`  ${g.domain}: ${g.count}${hist}`);
      for (const s of g.samples) console.log(`    - ${s.subject}`);
    }
  }

  return report;
}
