import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

/**
 * Every `hostDirectives` entry in the kit must state its `inputs`, even when empty.
 *
 * `hostDirectives` IS public API: a composed directive's input is bindable on our element
 * only if the entry lists it. The shorthand form (`hostDirectives: [BrnFoo]`) exposes
 * nothing, which is usually right — but it is a decision nobody made, and it hides the
 * opposite case just as well. Trinity shipped that bug: `HlmInput` composed
 * `BrnFieldControlDescribedBy`, whose `aria-describedby` input was not listed, so setting
 * `aria-describedby` on an `hlmInput` — static or bound — was silently overwritten with
 * null. It could not be set at all, and nothing said so (#153).
 *
 * Writing `inputs: []` is not ceremony, then: it is the difference between "we chose to
 * expose nothing" and "nobody looked". Audited once at 43 entries — only
 * `BrnFieldControlDescribedBy` declares an input at all, and the one place it is composed
 * without exposing it (`hlm-checkbox`) is deliberate and pinned separately. This keeps the
 * next composed directive from arriving unexamined.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The bracketed body immediately following `index`, with nesting respected. */
const arrayBody = (source, index) => {
  const open = source.indexOf('[', index);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unterminated hostDirectives array');
};

/** Split on commas that are not inside a nested bracket/brace/paren. */
const topLevelEntries = (body) => {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if ('[{('.includes(char)) depth += 1;
    else if (']})'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
};

describe('hostDirectives', () => {
  const files = globSync('libs/spartan/**/*.ts', { cwd: workspaceRoot }).filter(
    (file) => !file.endsWith('.spec.ts'),
  );

  const entries = files.flatMap((file) => {
    const source = stripComments(
      readFileSync(join(workspaceRoot, file), 'utf8'),
    );
    return [...source.matchAll(/hostDirectives:/g)].flatMap((match) =>
      topLevelEntries(arrayBody(source, match.index)).map((entry) => ({
        file,
        entry,
      })),
    );
  });

  it('finds the entries at all, so an empty sweep cannot pass as a clean one', () => {
    // Without this, a parser change that matched nothing would report every file
    // compliant — the classic way a source-shape guard stops guarding in silence.
    expect(entries.length).toBeGreaterThan(30);
  });

  it('states inputs on every entry, even when empty', () => {
    const bare = entries
      .filter(
        ({ entry }) => !entry.startsWith('{') || !/\binputs\b/.test(entry),
      )
      .map(({ file, entry }) => `${file}: ${entry.split('\n')[0].trim()}`);

    expect(bare).toEqual([]);
  });
});
