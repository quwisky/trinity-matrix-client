import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A spec must not restate the harness's registration secret or endpoint.
 *
 * Eighty-two specs each carried their own `registerUser`, their own
 * `SYNAPSE_HTTP = 'http://localhost:8008'` and their own
 * `REG_SECRET = 'trinity-e2e-shared-secret'`. Copy eighty-two is written by copying
 * eighty-one, so the whole set drifts together or not at all — and the failure when it does
 * drift is the quiet kind: `register_new_matrix_user` computes its HMAC with one secret
 * while Synapse validates against the other, and all a spec sees is
 * `403 M_FORBIDDEN: HMAC incorrect` from a line that looks correct.
 *
 * Five of those copies had already diverged behaviourally, and not decoratively: four
 * dropped the `res.ok()` check entirely, so a registration that failed for any reason other
 * than "user exists" was silent and the spec failed later, somewhere else, for a reason that
 * had nothing to do with the cause.
 *
 * The values now come from `e2e/synapse/start.mjs`, which is the file that patches them into
 * `homeserver.yaml` — one definition, on the side that actually configures Synapse.
 *
 * `mobile-nav.spec.mts` keeps a registration routine of its own, and is allowed to: it
 * registers in `beforeAll`, where Playwright's test-scoped `request` fixture does not exist,
 * so it uses global `fetch`. It still imports both constants rather than restating them,
 * which is the part this guards.
 */

const workspaceRoot = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

/** The literals that must appear only where they are defined. */
const RESTATED = [
  // Unquoted, so a backtick or double-quoted copy is caught too. `127.0.0.1` is included
  // because it is the spelling someone reaches for the day `localhost` resolves to ::1.
  {
    what: 'the registration shared secret',
    pattern: /trinity-e2e-shared-secret/,
  },
  { what: "Synapse's base URL", pattern: /(?:localhost|127\.0\.0\.1):8008/ },
];

/** The one file allowed to define them: the harness that writes them into homeserver.yaml. */
const DEFINITION = 'e2e/synapse/start.mjs';

/** Where the shared helpers live — `registerUser`'s home, not a copy of it. */
const EXEMPT = ['e2e/playwright/support/', 'e2e/synapse/'];

/**
 * The whole e2e tree, not just the Playwright specs.
 *
 * The first version of this guard globbed `e2e/playwright/**` and its docblock claimed the
 * constants had "one definition" — while `e2e/features/rooms.mjs` and `search.mjs`, both
 * live and both documented in `docs/contributing/testing.md`, restated BOTH literals and
 * carried a third `registerUser`. A guard narrower than the invariant it states is worse
 * than no guard: it reads as tree-wide and is not.
 */
const specs = globSync('e2e/**/*.{mts,mjs}', { cwd: workspaceRoot })
  .filter(
    (file) =>
      !file.includes('node_modules') &&
      !EXEMPT.some((prefix) => file.startsWith(prefix)),
  )
  .sort();

describe('e2e harness constants', () => {
  it('finds the specs at all, so an empty sweep cannot pass', () => {
    expect(specs.length).toBeGreaterThan(80);
    // Both file kinds are in reach, or the widened glob is decorative.
    expect(specs.some((file) => file.endsWith('.mjs'))).toBe(true);
    // And the definition really does define them, so the assertion below is about
    // duplication rather than about a value that has been renamed out of existence.
    const source = read(DEFINITION);
    for (const { pattern } of RESTATED) {
      expect(source).toMatch(pattern);
    }
  });

  it('never restates a harness constant in a spec', () => {
    const restated = [];
    for (const file of specs) {
      const source = read(file);
      for (const { what, pattern } of RESTATED) {
        if (pattern.test(source)) {
          restated.push(
            `${file} restates ${what} — import it from ${DEFINITION}`,
          );
        }
      }
    }

    expect(restated).toEqual([]);
  });

  it('registers through the shared helper, bar the one documented exception', () => {
    // A second local `registerUser` is how the first eighty-two happened. The exceptions are
    // named rather than pattern-matched, so adding another is a visible line here.
    //
    // The two that remain are the standalone `.mjs` runners, which drive Playwright's
    // library API directly and so have no `request` fixture to hand — they register over
    // plain `fetch`. They import both constants, which is the half that actually drifts.
    //
    // `mobile-nav.spec.mts` is NOT among them any more. It used to be, on the stated
    // grounds that `beforeAll` has no `request` fixture; that was simply false — Playwright
    // provisions one for the hook and only forbids reusing it inside a test.
    const local = specs.filter((file) =>
      /\b(?:function registerUser\(|const registerUser\s*=)/.test(read(file)),
    );

    expect(local).toEqual([
      'e2e/features/rooms.mjs',
      'e2e/features/search.mjs',
    ]);
  });
});
