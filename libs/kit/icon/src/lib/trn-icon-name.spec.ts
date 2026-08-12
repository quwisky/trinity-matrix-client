import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRN_ICON_NAMES } from './trn-icon-name';
import { TRN_ICONS } from './trn-icon.icons';

const workspaceRoot = join(import.meta.dirname, '../../../../..');

/**
 * Everything registered must still be used.
 *
 * `provideTrnIcons()` is called once at the app root, so the whole map is eager: unlike the
 * 32 per-component registrations it replaced, an entry nobody renders can never be
 * tree-shaken away. It just sits in `main` forever. Measured at the time of writing, the
 * icon SVGs are ~32.5 KB of the eager bundle, so silent accumulation is the one real cost
 * of centralising, and this is the check that stops it.
 */
describe('TrnIconName', () => {
  /**
   * Only real icon contexts count as a reference, and this is the part that took two
   * attempts to get right.
   *
   * A first version matched any quoted lowercase literal anywhere under `libs`, which made
   * every icon reference itself through this library's own union. A second version fixed
   * that but still counted any literal in feature code — measured, that left **10 of 82**
   * names unfalsifiable, because `'shield'`, `'play'`, `'user'` and friends appear in specs
   * and unrelated code. So three narrow channels: the `name="…"` attribute, literals inside
   * a `[name]` binding, and literals in the files that name `TrnIconName` — the five typed
   * maps, which is a different and much smaller set than "files importing the icon alias".
   */
  const grep = (args: readonly string[]): string =>
    execFileSync('grep', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

  const CALL_SITES = ['libs/feature', 'libs/ui', 'apps'];

  const templateNames = grep([
    '-rho',
    '--include=*.html',
    '-E',
    'name="[a-z0-9-]+"',
    ...CALL_SITES,
  ])
    .split('\n')
    .map((line) => line.replace(/^name="|"$/g, ''))
    .filter(Boolean);

  // The typed maps, and only those: files naming `TrnIconName` itself. Matching the alias
  // instead would pull in all 33 files that import `TrnIconComponent` for their template,
  // and any stray literal in one of them would then vouch for an icon nothing renders.
  const mapFiles = grep(['-rl', '--include=*.ts', 'TrnIconName', ...CALL_SITES])
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.endsWith('.spec.ts'));

  const mapNames = mapFiles.length
    ? grep(['-ho', '-E', "'[a-z0-9-]+'", ...mapFiles])
        .split('\n')
        .map((line) => line.replace(/'/g, ''))
        .filter(Boolean)
    : [];

  // Inline ternaries — `[name]="copied() ? 'check' : 'copy'"`. Matched inside the binding
  // itself rather than as "any quoted literal in a template": templates quote 110 distinct
  // lowercase words, only 15 of which are icons, so the broad form would let 95 unrelated
  // strings vouch for icons that nothing renders. `{{ n === 1 ? 'vote' : 'votes' }}` is a
  // real example — it would otherwise keep the `vote` icon alive on its own.
  const inlineNames = grep([
    '-rho',
    '--include=*.html',
    '-E',
    '\\[name\\]="[^"]*"',
    ...CALL_SITES,
  ])
    .split('\n')
    .flatMap((binding) =>
      [...binding.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]),
    )
    .filter(Boolean);

  const referenced = new Set([...templateNames, ...mapNames, ...inlineNames]);

  it('registers no icon that nothing renders', () => {
    const dead = TRN_ICON_NAMES.filter((name) => !referenced.has(name));
    expect(dead).toEqual([]);
  });

  it('maps every name, and only names', () => {
    // `Record<TrnIconName, string>` already makes this a compile error in both
    // directions; asserted at runtime too so the pairing survives someone widening the
    // type to `Partial<…>` or `Record<string, string>` to silence a build.
    expect(Object.keys(TRN_ICONS).sort()).toEqual([...TRN_ICON_NAMES].sort());
  });

  it('names icons in Trinity vocabulary, never the vendor identifiers', () => {
    // The point of the union is that a pack swap is one file. A `lucide*` name leaking in
    // means someone mapped a call site straight onto the vendor and the indirection is
    // already half gone.
    expect(TRN_ICON_NAMES.filter((name) => name.startsWith('lucide'))).toEqual(
      [],
    );
  });
});
