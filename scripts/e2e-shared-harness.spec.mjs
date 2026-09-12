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
 * The values now come from `e2e/support/synapse/start.mjs`, which patches them into
 * `homeserver.yaml` — one definition, on the side that actually configures Synapse.
 *
 * `compact-room-routing.spec.mts` keeps a registration routine of its own, and is allowed to: it
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
const DEFINITION = 'e2e/support/synapse/start.mjs';

/** Where the shared helpers live — `registerUser`'s home, not a copy of it. */
const EXEMPT = ['e2e/support/account.mts', 'e2e/support/synapse/'];

/**
 * The whole e2e tree, not just the Playwright specs.
 *
 * The first version of this guard globbed only the canonical browser journey tree and claimed the
 * constants had "one definition" — while the former rooms and search protocol drivers, both
 * live and both documented in the developer testing guide, restated BOTH literals and
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

/**
 * Every E2E module is an intentional target-input superset for this guard.
 *
 * The current checks exclude shared helpers and most Synapse modules after globbing, then read
 * `start.mjs` directly. Declaring the whole source corpus documents both paths and means a future
 * check cannot silently read outside the target's model merely because it starts using another
 * helper. The target itself is uncached because another guard reads the Git index.
 */
const e2eSources = globSync('e2e/**/*.{mts,mjs}', {
  cwd: workspaceRoot,
}).sort();
const scriptsProject = JSON.parse(read('scripts/project.json'));
const configuredE2eSources = globSync(
  scriptsProject.targets.test.inputs
    .filter(
      (input) =>
        typeof input === 'string' && input.startsWith('{workspaceRoot}/e2e/'),
    )
    .map((input) => input.replace('{workspaceRoot}/', '')),
  { cwd: workspaceRoot },
)
  .filter((file) => /\.(?:mts|mjs)$/.test(file))
  .sort();

describe('e2e harness constants', () => {
  it('declares the complete E2E module corpus in the scripts:test inputs', () => {
    expect(configuredE2eSources).toEqual(e2eSources);
    expect(configuredE2eSources).toContain(DEFINITION);
  });

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
    // `mobile-nav.spec.mts` is NOT among them any more. It used to be, on the stated
    // grounds that `beforeAll` has no `request` fixture; that was simply false — Playwright
    // provisions one for the hook and only forbids reusing it inside a test.
    const local = specs.filter((file) =>
      /\b(?:function registerUser\(|const registerUser\s*=)/.test(read(file)),
    );

    expect(local).toEqual([]);
  });
});
