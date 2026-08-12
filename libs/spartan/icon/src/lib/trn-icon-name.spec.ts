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
  const sources = execFileSync(
    'grep',
    [
      '-rho',
      '--include=*.html',
      '--include=*.ts',
      '-E',
      '(name="[a-z0-9-]+"|\'[a-z0-9-]+\')',
      // Call sites only. Scanning `libs` wholesale would include THIS library, whose
      // union and vendor map quote every name — so every icon would reference itself and
      // the check below could never fail. It did exactly that until a control caught it.
      'libs/feature',
      'libs/ui',
      'apps',
    ],
    { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const referenced = new Set(
    sources
      .split('\n')
      .map((line) => line.replace(/^name="|"$|^'|'$/g, ''))
      .filter(Boolean),
  );

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
