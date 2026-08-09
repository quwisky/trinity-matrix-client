import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const LEDGER_BASENAME = 'config-schema.ts';

/** A key literal: a quoted string starting `trinity.` — `[.]` to keep the shell out of it. */
const KEY_PATTERN = /'trinity\.[^']*'/gu;

/**
 * Shipped source only. Specs legitimately hold `trinity.*` strings that are not keys — a
 * fixture FILE named `trinity.gif`, a space-order key with a user id already appended — and
 * a new key is introduced in shipped source anyway, which is where a decision is owed.
 */
const SCAN = [
  'grep -rhoE',
  `"'trinity[.][^']*'"`,
  "--include='*.ts'",
  "--exclude='*.spec.ts'",
  `--exclude='${LEDGER_BASENAME}'`,
  'libs apps',
  '|| true',
].join(' ');

/** Every `trinity.*` key literal in shipped library and app source. */
function keysInSource() {
  const output = execSync(SCAN, { cwd: workspaceRoot, encoding: 'utf8' });
  const keys = output
    .split('\n')
    .filter(Boolean)
    .map((literal) => literal.slice(1, -1));
  return [...new Set(keys)].sort();
}

/** Every key the ledger classifies. */
function keysInLedger() {
  const source = readFileSync(join(workspaceRoot, LEDGER_FILE), 'utf8');
  return (source.match(KEY_PATTERN) ?? []).map((literal) =>
    literal.slice(1, -1),
  );
}

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
