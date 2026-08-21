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

/**
 * The other half of the surface. Tailwind utilities carry the same decisions as the
 * stylesheets — `z-30` is a z-index and `text-primary` is a colour — but they live in
 * templates, so a sweep that reads only `.scss` calls a rule "enforced everywhere" while the
 * one place it is broken sits in a file it never opens. Both escapees below were found that
 * way.
 */
const templates = ['libs/**/*.html', 'apps/**/*.html']
  .flatMap((pattern) => globSync(pattern, { cwd: workspaceRoot }))
  .filter((file) => !file.includes('node_modules'))
  .sort();

const read = (file) => readFileSync(join(workspaceRoot, file), 'utf8');

/**
 * A stylesheet with its comments removed.
 *
 * Prose is not code. The reduced-motion note in `variables.scss` has to quote
 * `animation: … infinite` to explain why collapsing a duration does not stop one, and the
 * sweeps below read that sentence as a violation — the same trap `scroll-behaviour.spec.mjs`
 * hit. Naive on purpose: over-removing text before searching for something that must not
 * appear at all is the safe direction.
 */
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

describe('styling tokens', () => {
  it('reads the stylesheets at all, so an empty sweep cannot pass as a clean one', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('uses the z-index scale for every app-level layer', () => {
    const raw = files
      .filter((file) => !LOCAL_STACKING.includes(file))
      .filter((file) => /z-index:\s*\d/.test(code(file)));

    expect(raw).toEqual([]);
  });

  it('uses the motion tokens for every transition', () => {
    // A literal duration cannot be collapsed by the reduced-motion block in variables.scss,
    // so it keeps moving for a user who asked it not to — the blanket `!important` in
    // global.scss is what still catches those, and it is meant to go away.
    const raw = files.filter((file) =>
      /transition:[^;]*\d+(\.\d+)?m?s/.test(code(file)),
    );

    expect(raw).toEqual([]);
  });

  it('keeps the literal keyframe durations to the recorded ledger', () => {
    const raw = files.filter((file) =>
      /animation:[^;]*\d+(\.\d+)?m?s/.test(code(file)),
    );

    // Equality, not a subset: an entry that gets migrated must leave the ledger, or the
    // ledger stops describing the tree and starts excusing it. It is empty now, so this
    // reads as "no SCSS stylesheet may hand-pick an animation duration".
    //
    // SCSS only: `files` globs `*.scss`, so `theme/spartan.css` — which is hand-written
    // wiring and does carry keyframes — is outside it. Nothing there hand-picks a duration
    // today, so this is a gap in reach rather than a miss, and widening the glob is a
    // separate change because the CSS file's `@theme` blocks are a different kind of thing.
    expect(raw).toEqual([...LITERAL_ANIMATIONS].sort());
  });

  it('reads the templates at all, so an empty sweep cannot pass as a clean one', () => {
    expect(templates.length).toBeGreaterThan(50);
  });

  it('uses the z-index scale in templates too, not a raw Tailwind layer', () => {
    // `z-30` on the mobile scrim was the one escapee, and it is exactly the shape that
    // matters: nothing related it to `--trinity-z-panel: 40`, the panel it must sit behind,
    // so renumbering the scale would have tied them with source order deciding.
    const raw = templates.filter((file) =>
      /class="[^"]*\bz-\d+\b/.test(read(file)),
    );

    expect(raw).toEqual([]);
  });

  it('paints accent TEXT with text-link, never with the text-primary fill', () => {
    // `--primary` aliases `--trinity-accent`, a fill: `:root.dark` never overrides it, so
    // `text-primary` renders blurple at 2.74:1 on the settings canvas. `text-link` maps to
    // the measured text role (see the note in theme/spartan.css). The negative lookahead is
    // load-bearing — `text-primary-foreground` is the ON-accent colour, a correct and
    // unrelated utility that sits on `bg-primary` fills.
    const offenders = templates.filter((file) =>
      /\btext-primary\b(?!-)/.test(read(file)),
    );

    expect(offenders).toEqual([]);
  });

  it('contains sideways scrolling wherever a surface scrolls sideways', () => {
    // iOS now has the WebView's back/forward swipe enabled, so a horizontal scroll that
    // reaches its end continues into the gesture and navigates away. Every `overflow-x`
    // surface therefore has to say the scroll stops with it. Checked as a pairing rather
    // than by eye, because the failure only shows on a device with the gesture — every
    // desktop browser looks fine.
    // COUNTED, not "does the file mention it anywhere". A file with two scrolling surfaces
    // and one containment reads as clean to a presence check, which is exactly the state
    // this guard's own first draft passed in.
    const offenders = files.filter((file) => {
      const source = code(file);
      const scrolls = (source.match(/overflow-x:\s*(?:auto|scroll)/g) ?? [])
        .length;
      const contained = (source.match(/overscroll-behavior-x/g) ?? []).length;
      return scrolls > contained;
    });

    expect(offenders).toEqual([]);
  });
});
