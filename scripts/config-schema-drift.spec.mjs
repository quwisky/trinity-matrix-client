import { execSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the invariant the config export lives or dies by: every `trinity.*` key the
 * workspace stores is classified in the schema ledger as exported, excluded, or internal.
 *
 * The curated schema was chosen over enumerating `Preferences.keys()` because enumeration
 * also picks up transient auth state and per-account prefixed keys. Its one cost is having
 * to stay in step — and that is not a cost discipline can carry: the issue's own key table
 * listed 13 keys and the tree held 24 by the time this was written, having drifted in the
 * weeks between. A key added without a decision is silently absent from every export, and
 * (worse) a key like `trinity.push.applied-app-id` added without a decision could later be
 * exported by default and strand a live pusher on someone's old gateway.
 *
 * It lives here rather than in a library spec because the keys are spread across
 * `platform-native`, three `data-access` libs and a `feature` lib, and the Nx boundary rules
 * (correctly) stop any one of them from importing all the others. Read as text for the same
 * reason `confirmation-words.spec.mjs` is.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/** The single classification table; excluded from the scan below so it can't classify itself. */
const LEDGER_FILE = 'libs/platform-native/src/lib/config-schema.ts';

/** A key literal: a quoted string starting `trinity.` — `[.]` to keep the shell out of it. */
const KEY_PATTERN = /'trinity\.[^']*'/gu;

/**
 * Shipped source only. Specs legitimately hold `trinity.*` strings that are not keys — a
 * fixture FILE named `trinity.gif`, a space-order key with a user id already appended — and
 * a new key is introduced in shipped source anyway, which is where a decision is owed.
 *
 * `-o` keeps the filename on each match so the ledger can be skipped **by path**. A grep
 * `--exclude` matches basenames only, which would make any future `config-schema.ts` in any
 * other lib invisible to this guard — precisely the "a key nobody classified" case it exists
 * to catch.
 */
const SCAN = [
  'grep -roE',
  `"'trinity[.][^']*'"`,
  "--include='*.ts'",
  "--exclude='*.spec.ts'",
  'libs apps',
  '|| true',
].join(' ');

/** Every `trinity.*` key literal in shipped source under `root`, ignoring `exempt`. */
function scanKeys(root, exempt) {
  const output = execSync(SCAN, { cwd: root, encoding: 'utf8' });
  const keys = [];
  for (const line of output.split('\n')) {
    const separator = line.indexOf(":'");
    if (separator < 0) {
      continue;
    }
    if (line.slice(0, separator) === exempt) {
      continue;
    }
    keys.push(line.slice(separator + 2, -1));
  }
  return [...new Set(keys)].sort();
}

/** Every `trinity.*` key literal in shipped library and app source. */
function keysInSource() {
  return scanKeys(workspaceRoot, LEDGER_FILE);
}

/**
 * The dotted paths the config entries declare, across every library that contributes them.
 *
 * Textual for the reason the key scan is: the entries live in four libraries the Nx
 * boundaries stop from importing one another, so no single suite can hold all of them at
 * once. The runtime guard (`configSchemaDrift`) checks each library's own contribution
 * thoroughly; a path claimed by *two* libraries is the one fault it structurally cannot see,
 * and it is the fault that silently drops a setting out of the document.
 *
 * Narrow includes rather than a bare `*config*.ts`, which would sweep in `vite.config.ts` and
 * every other build file that happens to have a `path:` in it.
 */
const PATH_SCAN = [
  'grep -rhoE',
  `"path: '[^']+'"`,
  "--include='*-config-entries.ts'",
  "--include='*-config.ts'",
  "--exclude='*.spec.ts'",
  'libs',
  '|| true',
].join(' ');

function pathsInEntries() {
  const output = execSync(PATH_SCAN, { cwd: workspaceRoot, encoding: 'utf8' });
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf("'") + 1, -1));
}

/** Every key the ledger classifies. */
function keysInLedger() {
  const source = readFileSync(join(workspaceRoot, LEDGER_FILE), 'utf8');
  return (source.match(KEY_PATTERN) ?? []).map((literal) =>
    literal.slice(1, -1),
  );
}

/** Scan a throwaway tree of `path → contents`, so the scanner itself can be tested. */
function scanFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'config-schema-drift-'));
  try {
    mkdirSync(join(root, 'apps'), { recursive: true });
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    return scanKeys(root, LEDGER_FILE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the scanner', () => {
  it('sees a config-schema.ts that is not the ledger', () => {
    // The exemption is for the one classification table, not for the name. A lib adding its
    // own `config-schema.ts` must still be scanned, or a key nobody classified hides in the
    // one file shaped like the place a classification would live.
    expect(
      scanFixture({
        'libs/other/src/lib/config-schema.ts': "const KEY = 'trinity.decoy';\n",
      }),
    ).toEqual(['trinity.decoy']);
  });

  it('still exempts the ledger, so it cannot classify itself', () => {
    expect(
      scanFixture({ [LEDGER_FILE]: "key: 'trinity.only-in-the-ledger',\n" }),
    ).toEqual([]);
  });
});

describe('config schema drift', () => {
  it('finds the keys at all', () => {
    // Guard the guard. If the grep or the path ever stops matching, both checks below pass
    // vacuously and the schema is unguarded while the run stays green.
    expect(keysInSource().length).toBeGreaterThan(15);
    expect(keysInLedger().length).toBeGreaterThan(15);
  });

  it('classifies each key exactly once', () => {
    const classified = keysInLedger();

    expect(new Set(classified).size).toBe(classified.length);
  });

  it('classifies every trinity.* key the workspace stores', () => {
    const classified = new Set(keysInLedger());
    const unclassified = keysInSource().filter((key) => !classified.has(key));

    expect(
      unclassified,
      `Add these keys to CONFIG_KEY_LEDGER in ${LEDGER_FILE}, as 'exported' (with an ` +
        `entry in the owning lib's config entries) or as 'excluded'/'internal' with a reason.`,
    ).toEqual([]);
  });

  it('finds the document paths at all', () => {
    // Guard the guard, as above: a scan that stops matching would leave the check below
    // passing on an empty list.
    expect(pathsInEntries().length).toBeGreaterThan(15);
  });

  it('has no document path claimed by two libraries', () => {
    const paths = pathsInEntries();
    const seen = new Set();
    const duplicated = paths.filter((path) => {
      const already = seen.has(path);
      seen.add(path);
      return already;
    });

    expect(
      duplicated,
      'Two config entries declare the same path, so only one of them can reach the ' +
        'document and the other is silently absent from every export. Give each its own ' +
        "path, under its own library's top-level group.",
    ).toEqual([]);
  });

  it('has no classification left over for a key that is gone', () => {
    const inSource = new Set(keysInSource());
    const stale = keysInLedger().filter((key) => !inSource.has(key));

    expect(
      stale,
      `These keys are classified in ${LEDGER_FILE} but no longer exist in libs/ or apps/. ` +
        `Drop the record — and its config entry, if it had one.`,
    ).toEqual([]);
  });
});
