import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Once a token layer exists, a raw value beside it is a fork in the vocabulary.
 *
 * This is a **frozen ledger**, not an aspiration: every entry below is a value that is
 * deliberately still a literal, with the reason. The assertion is that the set does not GROW.
 * A spec asserting the end state would fail on the day it landed and be deleted the first
 * time it cried wolf.
 *
 * Why these two properties and not, say, colour: `stylelint` already has
 * `declaration-property-value-disallowed-list` wired for colours, and z-index and duration
 * are the two layers where the raw values carried no relation to each other at all — 5, 10,
 * 20 and 40 with nothing saying which was meant to sit over which, and six hand-picked
 * durations across six files.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/**
 * Local stacking: these order a component's own children against each other, not against
 * anything in the app. The z-index scale governs app-level layers; pretending it governs
 * these would make both harder to read.
 */
const LOCAL_STACKING = [
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-user-panel/sidebar-user-panel.component.scss',
  'apps/trinity/src/rendered-markdown.scss',
];

/**
 * Keyframe animations carry no literal durations any more.
 *
 * They used to, and this was a ledger of the three that did — a recording-pulse, a drawer
 * entrance and an attention flash — deferred because the fast/base/slow scale had no word
 * for them. It does now: `--trinity-duration-pulse` and `--trinity-duration-flash` name the
 * two kinds of motion that are not transitions, and the drawer turned out to be plain
 * `--trinity-duration-base` all along.
 *
 * The ledger is empty and the assertion stays, so it is a floor rather than a description:
 * a new `animation:` with a hand-picked duration re-opens it, and that value cannot be
 * collapsed by the reduced-motion block in `variables.scss` — which is the whole reason to
 * care.
 */
const LITERAL_ANIMATIONS = [];

const files = ['libs/**/*.scss', 'apps/**/*.scss']
  .flatMap((pattern) => globSync(pattern, { cwd: workspaceRoot }))
  .filter((file) => !file.includes('node_modules'))
  .sort();

const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

describe('styling tokens', () => {
  it('reads the stylesheets at all, so an empty sweep cannot pass as a clean one', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('uses the z-index scale for every app-level layer', () => {
    const raw = files
      .filter((file) => !LOCAL_STACKING.includes(file))
      .filter((file) => /z-index:\s*\d/.test(read(file)));

    expect(raw).toEqual([]);
  });

  it('uses the motion tokens for every transition', () => {
    // A literal duration cannot be collapsed by the reduced-motion block in variables.scss,
    // so it keeps moving for a user who asked it not to — the blanket `!important` in
    // global.scss is what still catches those, and it is meant to go away.
    const raw = files.filter((file) =>
      /transition:[^;]*\d+(\.\d+)?m?s/.test(read(file)),
    );

    expect(raw).toEqual([]);
  });

  it('keeps the literal keyframe durations to the recorded ledger', () => {
    const raw = files.filter((file) =>
      /animation:[^;]*\d+(\.\d+)?m?s/.test(read(file)),
    );

    // Equality, not a subset: an entry that gets migrated must leave the ledger, or the
    // ledger stops describing the tree and starts excusing it. It is empty now, so this
    // reads as "no stylesheet may hand-pick an animation duration".
    expect(raw).toEqual([...LITERAL_ANIMATIONS].sort());
  });
});
