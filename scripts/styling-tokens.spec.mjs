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
 * Keyframe animations still carry literal durations. They are not transitions — each is a
 * one-off with a duration chosen for that specific motion (a 1.6s highlight flash, a 1s
 * recording pulse) — and the motion scale does not yet have a vocabulary for them. Phase 3
 * of the redesign gives them one; until then this records that they were considered.
 */
const LITERAL_ANIMATIONS = [
  'libs/feature/rooms/src/lib/message-composer/message-composer.component.scss',
  'libs/feature/rooms/src/lib/rooms/rooms.page.scss',
  'libs/feature/rooms/src/lib/message-row/message-row.component.scss',
];

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

  it('leaves the message body without a font-size of its own', () => {
    // Settings → Appearance → Text size works by scaling the ROOT font size, so the message
    // body must inherit. A component that hard-codes a size onto `.msg__text` silently opts
    // the timeline out of the entire feature, and the app still looks correct until someone
    // changes the setting.
    //
    // `e2e/playwright/text-scaling.spec.mts` proves this at runtime by measuring a real
    // message before and after — the stronger check, and the one that would catch a size
    // arriving from a parent or a utility class. It needs Docker, so this cheap reading of
    // the stylesheet runs on every commit and fails in the second the regression is written.
    const source = read(
      'libs/feature/rooms/src/lib/message-row/message-row.component.scss',
    );

    // Brace DEPTH, not the first `}`. Slicing to the first one stops at the end of any
    // nested rule, so a declaration written after `&:hover { … }` was invisible — and with a
    // rem token the px ratchet below could not see it either, so the regression this whole
    // guard exists for passed both checks in silence. Verified before and after.
    const rules = [];
    for (const match of source.matchAll(/^([^\n{]*\.msg__text[^\n{]*)\{/gm)) {
      const start = match.index + match[0].length;
      let depth = 1;
      let end = start;
      while (end < source.length && depth > 0) {
        if (source[end] === '{') depth++;
        else if (source[end] === '}') depth--;
        if (depth > 0) end++;
      }
      rules.push({ selector: match[1].trim(), body: source.slice(start, end) });
    }

    // Four rules target it today. Without this, renaming the class would leave nothing to
    // check and the sweep would pass by finding nothing at all.
    expect(rules.length).toBeGreaterThanOrEqual(4);
    expect(
      rules
        .filter((rule) => /font-size:/.test(rule.body))
        .map((r) => r.selector),
    ).toEqual([]);
  });

  it('does not let the px font-size count grow', () => {
    // The text-size setting has a documented limit: chrome that hard-codes px does not
    // scale. That limit is a NUMBER, and a number written in a comment goes stale in
    // silence — this one was cited as 147 in the e2e while the tree held 155. So it lives
    // here instead, as a ratchet.
    //
    // It may only fall. Converting a surface to the type tokens lowers it, which is a
    // one-line diff in the right direction; adding a px font-size raises it, which is a
    // visible edit to a shared file rather than an invisible default.
    const declarations = files.flatMap(
      (file) => read(file).match(/font-size:\s*[0-9.]+px/g) ?? [],
    );

    expect(declarations.length).toBeLessThanOrEqual(140);
  });

  it('keeps the literal keyframe durations to the recorded ledger', () => {
    const raw = files.filter((file) =>
      /animation:[^;]*\d+(\.\d+)?m?s/.test(read(file)),
    );

    // Equality, not a subset: an entry that gets migrated must leave the ledger, or the
    // ledger stops describing the tree and starts excusing it.
    expect(raw).toEqual([...LITERAL_ANIMATIONS].sort());
  });
});
