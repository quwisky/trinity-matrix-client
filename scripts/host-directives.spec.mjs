import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * Writing `inputs: []` and `outputs: []` is not ceremony, then: it is the difference between
 * "we chose to expose nothing" and "nobody looked". Audited once at 43 entries — across every
 * composed directive only `BrnFieldControlDescribedBy` declares an input and only `CdkMenu`
 * declares an output, and both are unexposed on purpose (see their sites). This keeps the
 * next composed directive from arriving unexamined.
 *
 * These files are `.prettierignore`d (`libs/spartan/**` + `hlm-*.ts`, so a CLI re-sync does
 * not fight prettier-plugin-tailwindcss), which means formatting here is hand-maintained —
 * `pnpm format:check` will not catch a stray comma in them.
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

  it('states inputs and outputs on every entry, even when empty', () => {
    // Both, because Angular treats them identically: `validateHostDirective` checks each
    // with the same `validateMappings`, and `trackHostDirectiveDef` merges each with the
    // same `mergeBindingMaps`. An unstated `outputs` swallows a composed directive's output
    // exactly the way an unstated `inputs` swallowed `aria-describedby`. `CdkMenu.closed`
    // is the one such output in this kit, and it is now silent by decision, not omission.
    const bare = entries
      .filter(
        ({ entry }) =>
          !entry.startsWith('{') ||
          !/\binputs\b/.test(entry) ||
          !/\boutputs\b/.test(entry),
      )
      .map(({ file, entry }) => `${file}: ${entry.split('\n')[0].trim()}`);

    expect(bare).toEqual([]);
  });
});
