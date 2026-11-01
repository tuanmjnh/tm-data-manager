/**
 * Reports i18n keys used by the GUI that are missing from a locale file, plus
 * keys that drifted between locales. Run with `node scripts/check-i18n.mjs`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const localesDir = join(root, 'app', 'i18n', 'locales');

const flatten = (object, prefix = '') =>
  Object.entries(object).flatMap(([key, value]) =>
    value && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );

const readLocale = (name) => JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
const en = readLocale('en');
const vi = readLocale('vi');
const enKeys = new Set(flatten(en));
const viKeys = new Set(flatten(vi));

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.nuxt', '.output'].includes(entry.name)) continue;
      walk(join(dir, entry.name));
    } else if (/\.(vue|ts)$/.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
};
walk(join(root, 'app'));

const used = new Map();
const pattern = /(?:\$t|\bt)\(\s*'([a-zA-Z0-9_.]+)'/g;
for (const file of files) {
  for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
    if (!used.has(match[1])) used.set(match[1], new Set());
    used.get(match[1]).add(file.slice(root.length));
  }
}

const missingEn = [...used.keys()].filter((key) => !enKeys.has(key));
const missingVi = [...used.keys()].filter((key) => !viKeys.has(key));
const notInEn = [...viKeys].filter((key) => !enKeys.has(key));
const notInVi = [...enKeys].filter((key) => !viKeys.has(key));

console.log(`keys used in app: ${used.size}`);
console.log(`en: ${enKeys.size} · vi: ${viKeys.size}`);
for (const [label, list] of [
  ['missing in en', missingEn],
  ['missing in vi', missingVi],
  ['only in vi', notInEn],
  ['only in en', notInVi],
]) {
  console.log(`${label}: ${list.length}`);
  for (const key of list) console.log(`  - ${key} ${[...(used.get(key) ?? [])].join(', ')}`);
}

if (missingEn.length || missingVi.length || notInEn.length || notInVi.length) process.exitCode = 1;
