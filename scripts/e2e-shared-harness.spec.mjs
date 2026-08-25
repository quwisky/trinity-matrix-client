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
  {
    what: 'the registration shared secret',
    pattern: /'trinity-e2e-shared-secret'/,
  },
  { what: "Synapse's base URL", pattern: /'http:\/\/localhost:8008'/ },
];

/** The one file allowed to define them: the harness that writes them into homeserver.yaml. */
const DEFINITION = 'e2e/synapse/start.mjs';

/** Where the shared helpers live — `registerUser`'s home, not a copy of it. */
const SUPPORT = 'e2e/playwright/support/';

const specs = globSync('e2e/playwright/**/*.mts', { cwd: workspaceRoot })
  .filter((file) => !file.includes('node_modules') && !file.startsWith(SUPPORT))
  .sort();

describe('e2e harness constants', () => {
  it('finds the specs at all, so an empty sweep cannot pass', () => {
    expect(specs.length).toBeGreaterThan(80);
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
    // A second local `registerUser` is how the first eighty-two happened. The exception is
    // named rather than pattern-matched, so adding a third is a visible line here.
    const local = specs.filter((file) =>
      /\bfunction registerUser\(/.test(read(file)),
    );

    expect(local).toEqual(['e2e/playwright/mobile-nav.spec.mts']);
  });
});
