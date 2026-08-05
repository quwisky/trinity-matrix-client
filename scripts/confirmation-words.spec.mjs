import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards an invariant no single library can assert: the type-to-confirm words that gate
 * Trinity's irreversible actions must all be DIFFERENT from each other.
 *
 * Both gates are reached by someone already in trouble — one after losing a recovery key,
 * the other after the app has wedged — and both destroy something no server copy can
 * restore. If they ever shared a word, muscle memory from the smaller action would carry a
 * user straight through the larger one, which is precisely what typing a word is meant to
 * prevent.
 *
 * It lives here because the modules are in sibling `type:feature` libraries, and the Nx
 * boundary rules forbid one feature from importing another — correctly, since this is the
 * only thing they have in common. Read as text rather than imported for the same reason.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/** Where each gate's word is defined, and the constant that holds it. */
const GATES = [
  {
    what: 'encryption reset',
    file: 'libs/feature/crypto/src/lib/encryption-unlock/recovery-reset.ts',
    constant: 'RESET_CONFIRMATION_WORD',
  },
  {
    what: 'clear all data',
    file: 'libs/feature/auth/src/lib/login/clear-all-data.ts',
    constant: 'CLEAR_DATA_CONFIRMATION_WORD',
  },
];

/** Pull `export const NAME = '...'` out of a module without importing it. */
function readWord({ file, constant }) {
  const source = readFileSync(join(workspaceRoot, file), 'utf8');
  const match = new RegExp(`export const ${constant} = '([^']+)'`, 'u').exec(
    source,
  );
  return match?.[1] ?? null;
}

describe('type-to-confirm words', () => {
  it.each(GATES)('$what defines its word as a string literal', (gate) => {
    // If this fails the constant was refactored (computed, imported, template literal) and
    // the uniqueness check below silently stopped checking anything.
    expect(readWord(gate)).toMatch(/^[A-Z]+$/);
  });

  it('never reuses a word between two irreversible actions', () => {
    const words = GATES.map(readWord);

    expect(new Set(words).size).toBe(words.length);
  });
});
