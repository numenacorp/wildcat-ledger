#!/usr/bin/env node
/**
 * Fails when any of a list of terms appears in this fork's own files.
 *
 * The fork is kept to generic accounting. This check is how that is enforced:
 * the terms that must stay out are supplied from outside the repository, one
 * per line, either in the file named by TERMS_FILE or in the TERMS variable.
 * A term is matched as a whole word, ignoring case. With no terms supplied the
 * check fails, so that it can never pass by being unconfigured, unless
 * `--allow-empty` is given.
 *
 *   TERMS_FILE=/path/to/terms.txt node scripts/check-terms.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

/** The files and folders this fork added to Bigcapital. */
const OWN_PATHS = [
  'README.md',
  'AGENTS.md',
  'FORK.md',
  'package.json',
  '.env.example',
  'docker-compose.yml',
  'docker-compose.local.yml',
  'packages/server/Dockerfile',
  'packages/server/src/common/request-body.ts',
  'packages/server/src/common/config',
  'packages/server/src/main.ts',
  'packages/server/src/modules/Ledger/LedgerEntriesStorage.service.ts',
  'packages/server/src/modules/ManualJournals/commands',
  'scripts',
  '.github/workflows/ledger.yml',
  'packages/server/src/modules/LedgerExt',
  'packages/server/test/ledger',
];

/** Migrations of the extension, wherever they sit among Bigcapital's. */
const OWN_FILE_PATTERNS = [/[\\/]migrations[\\/]\d+_ledger_ext_[^\\/]+$/];
const PATTERN_ROOTS = ['packages/server/src/database'];

const walk = (path) => {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (stat.isFile()) return [path];
  return readdirSync(path)
    .filter((name) => name !== 'node_modules' && name !== 'dist')
    .flatMap((name) => walk(join(path, name)));
};

const loadTerms = () => {
  const raw = process.env.TERMS_FILE
    ? readFileSync(process.env.TERMS_FILE, 'utf8')
    : (process.env.TERMS ?? '');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
};

const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const terms = loadTerms();
if (terms.length === 0) {
  if (process.argv.includes('--allow-empty')) {
    console.log('check-terms: no terms supplied, nothing checked.');
    process.exit(0);
  }
  console.error('check-terms: no terms supplied. Set TERMS_FILE or TERMS.');
  process.exit(2);
}

const files = [
  ...OWN_PATHS.flatMap((path) => walk(join(root, path))),
  ...PATTERN_ROOTS.flatMap((path) => walk(join(root, path))).filter((file) =>
    OWN_FILE_PATTERNS.some((pattern) => pattern.test(file)),
  ),
];

const matchers = terms.map((term) => ({
  term,
  // A whole-word match: not preceded or followed by a letter or digit.
  regex: new RegExp(`(?<![A-Za-z0-9])${escape(term)}(?![A-Za-z0-9])`, 'i'),
}));

let found = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { term, regex } of matchers) {
      if (regex.test(line)) {
        found += 1;
        // The term itself is not printed: the log of a public build is public.
        console.error(`${relative(root, file)}:${index + 1}: term #${terms.indexOf(term) + 1}`);
      }
    }
  });
}

if (found > 0) {
  console.error(`check-terms: ${found} match(es) in ${files.length} files.`);
  process.exit(1);
}
console.log(`check-terms: ${files.length} files clean against ${terms.length} terms.`);
