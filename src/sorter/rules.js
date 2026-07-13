import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(__dirname, '..', '..', 'config', 'rules.json');
const VALID_BUCKETS = new Set(['accounting', 'notifications', 'keep']);

export function loadRules(configPath = DEFAULT_CONFIG) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(raw.guards)) throw new Error('guards must be an array');
  if (!Array.isArray(raw.rules)) throw new Error('rules must be an array');

  const ids = new Set();
  const compiled = [];

  for (const rule of raw.rules) {
    if (!rule.id) throw new Error('rule missing id');
    if (ids.has(rule.id)) throw new Error(`duplicate rule id: ${rule.id}`);
    ids.add(rule.id);

    if (!VALID_BUCKETS.has(rule.bucket)) {
      throw new Error(`unknown bucket "${rule.bucket}" in rule ${rule.id}`);
    }
    if (!Array.isArray(rule.domains) || rule.domains.length === 0) {
      throw new Error(`rule ${rule.id} must have at least one domain`);
    }
    for (const d of rule.domains) {
      if (d.includes('@')) throw new Error(`domain "${d}" in rule ${rule.id} must not contain @`);
      if (!d.includes('.')) throw new Error(`domain "${d}" in rule ${rule.id} must contain a dot`);
      if (d !== d.toLowerCase()) throw new Error(`domain "${d}" in rule ${rule.id} must be lowercase`);
    }

    let subjectRe = null;
    if (rule.subject) {
      try {
        subjectRe = new RegExp(rule.subject, 'i');
      } catch (e) {
        throw new Error(`bad regex in rule ${rule.id}: ${e.message}`);
      }
    }

    let subjectExcludeRe = null;
    if (rule.subjectExclude) {
      try {
        subjectExcludeRe = new RegExp(rule.subjectExclude, 'i');
      } catch (e) {
        throw new Error(`bad subjectExclude regex in rule ${rule.id}: ${e.message}`);
      }
    }

    if (rule.ignoreGuards !== undefined && typeof rule.ignoreGuards !== 'boolean') {
      throw new Error(`ignoreGuards must be boolean in rule ${rule.id}`);
    }

    compiled.push({
      id: rule.id,
      bucket: rule.bucket,
      domains: rule.domains.slice().sort((a, b) => b.length - a.length),
      subjectRe,
      subjectExcludeRe,
      ignoreGuards: rule.ignoreGuards || false,
      probationUntil: rule.probationUntil || null,
      note: rule.note || null,
      added: rule.added || null
    });
  }

  // Parse optional settings
  const rawSettings = raw.settings || {};
  const minAgeHours = rawSettings.minAgeHours !== undefined ? rawSettings.minAgeHours : 6;
  if (typeof minAgeHours !== 'number' || !isFinite(minAgeHours) || minAgeHours < 0) {
    throw new Error(`settings.minAgeHours must be a non-negative finite number, got: ${minAgeHours}`);
  }
  const settings = { minAgeHours };

  const guards = raw.guards.map(g => g.toLowerCase());
  return { guards, rules: compiled, settings, raw };
}

function domainMatches(emailDomain, ruleDomain) {
  return emailDomain === ruleDomain || emailDomain.endsWith('.' + ruleDomain);
}

export function classify(senderAddress, subject, config) {
  const { guards, rules } = config;
  const addr = senderAddress.toLowerCase();
  const atIdx = addr.lastIndexOf('@');
  if (atIdx < 0) return { bucket: null };
  const domain = addr.slice(atIdx + 1);
  const subj = subject || '';

  const BUCKET_ORDER = { accounting: 0, notifications: 1, keep: 2 };
  let bestMatch = null;
  let bestDomainLen = -1;
  let bestBucketPri = 999;

  for (const rule of rules) {
    let matchedDomainLen = 0;
    let matched = false;
    for (const d of rule.domains) {
      if (domainMatches(domain, d)) {
        matched = true;
        matchedDomainLen = d.length;
        break;
      }
    }
    if (!matched) continue;

    if (rule.subjectRe && !rule.subjectRe.test(subj)) continue;
    if (rule.subjectExcludeRe && rule.subjectExcludeRe.test(subj)) continue;

    const pri = BUCKET_ORDER[rule.bucket];
    if (pri < bestBucketPri || (pri === bestBucketPri && matchedDomainLen > bestDomainLen)) {
      bestMatch = rule;
      bestDomainLen = matchedDomainLen;
      bestBucketPri = pri;
    }
  }

  if (!bestMatch) return { bucket: null };

  let guarded = false;
  if (bestMatch.bucket !== 'keep' && !bestMatch.ignoreGuards) {
    const subjLower = subj.toLowerCase();
    for (const g of guards) {
      if (subjLower.includes(g)) {
        guarded = true;
        break;
      }
    }
  }

  return { bucket: bestMatch.bucket, ruleId: bestMatch.id, guarded };
}

export function subjectKey(subject) {
  if (!subject) return '';
  return subject
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
