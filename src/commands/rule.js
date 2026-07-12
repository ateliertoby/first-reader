import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../sorter/rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'rules.json');

export function addRule(config, { bucket, domains, subject, note }) {
  const base = domains[0].replace(/\./g, '-');
  let id = base;
  const existing = new Set(config.rules.map(r => r.id));
  if (existing.has(id)) {
    let n = 2;
    while (existing.has(`${base}-${n}`)) n++;
    id = `${base}-${n}`;
  }

  const now = new Date();
  const probation = new Date(now);
  probation.setDate(probation.getDate() + 7);

  const entry = { id, bucket, domains };
  if (subject) entry.subject = subject;
  if (note) entry.note = note;
  entry.added = now.toISOString().slice(0, 10);
  entry.probationUntil = probation.toISOString().slice(0, 10);

  const newConfig = { ...config, rules: [...config.rules, entry] };
  return { config: newConfig, id };
}

export function removeRule(config, id) {
  const filtered = config.rules.filter(r => r.id !== id);
  if (filtered.length === config.rules.length) {
    throw new Error(`rule "${id}" not found`);
  }
  return { ...config, rules: filtered };
}

export function addGuard(config, word) {
  if (config.guards.includes(word.toLowerCase())) {
    throw new Error(`guard "${word}" already exists`);
  }
  return { ...config, guards: [...config.guards, word.toLowerCase()] };
}

export function removeGuard(config, word) {
  const lower = word.toLowerCase();
  const filtered = config.guards.filter(g => g !== lower);
  if (filtered.length === config.guards.length) {
    throw new Error(`guard "${word}" not found`);
  }
  return { ...config, guards: filtered };
}

function writeConfig(config) {
  // Validate before write
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
  loadRules(tmpPath); // throws on invalid
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export async function ruleList(options) {
  const { guards, rules } = loadRules();
  const bucket = options.bucket;

  console.log('Guards:', guards.join(', '));
  console.log('');

  const filtered = bucket ? rules.filter(r => r.bucket === bucket) : rules;
  for (const r of filtered) {
    const parts = [`${r.id}`, `[${r.bucket}]`, r.domains.join(', ')];
    if (r.subjectRe) parts.push(`/${r.subjectRe.source}/i`);
    if (r.probationUntil) parts.push(`(probation until ${r.probationUntil})`);
    console.log('  ' + parts.join('  '));
  }
  console.log(`\n${filtered.length} rules`);
}

export async function ruleAdd(options) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const domains = Array.isArray(options.domain) ? options.domain : [options.domain];

  // Validate regex compiles
  if (options.subject) {
    try { new RegExp(options.subject, 'i'); }
    catch (e) { throw new Error(`bad regex: ${e.message}`); }
  }

  // Validate domains
  for (const d of domains) {
    if (d.includes('@')) throw new Error(`domain "${d}" must not contain @`);
    if (!d.includes('.')) throw new Error(`domain "${d}" must contain a dot`);
    if (d !== d.toLowerCase()) throw new Error(`domain "${d}" must be lowercase`);
  }

  // Warn if domain already covered
  const { rules } = loadRules();
  for (const d of domains) {
    const existing = rules.find(r => r.domains.includes(d));
    if (existing) console.log(`Warning: domain "${d}" already in rule "${existing.id}"`);
  }

  const { config: newConfig, id } = addRule(raw, {
    bucket: options.bucket,
    domains,
    subject: options.subject || null,
    note: options.note || null
  });
  writeConfig(newConfig);
  console.log(`Added rule "${id}" [${options.bucket}] for ${domains.join(', ')}`);
}

export async function ruleRm(id) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const newConfig = removeRule(raw, id);
  writeConfig(newConfig);
  console.log(`Removed rule "${id}"`);
}

export async function ruleGuardAdd(word) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const newConfig = addGuard(raw, word);
  writeConfig(newConfig);
  console.log(`Added guard "${word}"`);
}

export async function ruleGuardRm(word) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const newConfig = removeGuard(raw, word);
  writeConfig(newConfig);
  console.log(`Removed guard "${word}"`);
}
