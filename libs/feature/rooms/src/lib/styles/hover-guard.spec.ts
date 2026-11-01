import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const GUARD = /@media\s*\(hover:\s*hover\)\s*\{/;

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith('.scss') ? [path] : [];
  });
}

/** Lines that mention `:hover` outside an `@media (hover: hover)` block. */
export function unguardedHover(source: string): string[] {
  const found: string[] = [];
  const guardDepths: number[] = [];
  let depth = 0;
  for (const line of source.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    if (/:hover\b/.test(code) && guardDepths.length === 0) {
      found.push(line.trim());
    }
    if (GUARD.test(code)) guardDepths.push(depth);
    for (const ch of code) {
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (guardDepths.at(-1) === depth) guardDepths.pop();
      }
    }
  }
  return found;
}

describe('hover styles on touch screens', () => {
  it('sees an unguarded and a guarded :hover', () => {
    expect(unguardedHover('.a {\n  &:hover { color: red; }\n}')).toHaveLength(
      1,
    );
    expect(
      unguardedHover(
        '.a {\n  @media (hover: hover) {\n    &:hover { color: red; }\n  }\n}',
      ),
    ).toHaveLength(0);
  });

  it('finds the rooms stylesheets', () => {
    expect(stylesheets(ROOT).length).toBeGreaterThan(30);
  });

  // `:hover` keeps matching after a finger lifts, so a row would stay shaded until the next touch.
  it.each(stylesheets(ROOT).map((path) => [path.slice(ROOT.length + 1), path]))(
    'keeps %s :hover behind (hover: hover)',
    (_name, path) => {
      expect(unguardedHover(readFileSync(path, 'utf8'))).toEqual([]);
    },
  );
});
