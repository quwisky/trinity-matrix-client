import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The CSS a component declares in an inline `styles: [...]` array.
 *
 * Trinity's third styling idiom, after a `styleUrl` stylesheet and Tailwind utilities in the
 * template. Ten wrapper components in `libs/components` use it, and every styling guard read
 * `.scss` files only — so those rules were counted by nothing. That is not a hypothetical
 * gap: the action sheet's safe-area rule was one of them, and composed an unlayered author
 * declaration with a layered utility — the exact shape #219 shipped. Its migration is now a
 * fixture proving this extractor notices layered inline CSS too.
 *
 * Shared by `shorthand-overrides` and `styling-idiom` rather than copied into each, because
 * a parser that silently stops matching makes every guard reading it pass on a broken tree,
 * and one copy is one place to prove that has not happened.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/**
 * The contents of a `styles:` array, as one CSS string per component file.
 *
 * Bracket-matched rather than regex-terminated: CSS attribute selectors contain `]`, so
 * `/styles:\s*\[([\s\S]*?)\]/` truncates at the first `[data-slot="x"]` and hands back half
 * a stylesheet. The scan tracks quote state — all three forms — so a bracket inside the CSS
 * does not close the array either.
 */
/**
 * Blank out comments, preserving offsets so the scan below still lines up.
 *
 * The scanner tracks quote state, and an apostrophe inside a comment opened a string that
 * never closed — so the array's `]` was swallowed and the scan ran to EOF. It was live:
 * `trn-icon.component.ts` says "the strut's half-leading" in a `//` comment inside its
 * `styles:` array, and the extracted "CSS" was 400 characters of class names and TypeScript.
 * Nothing noticed, because the self-checks could only detect under-capture.
 */
const blankComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

export function inlineStylesOf(rawSource) {
  const source = blankComments(rawSource);
  const blocks = [];
  for (const match of source.matchAll(/\bstyles\s*:\s*\[/g)) {
    let index = match.index + match[0].length;
    const start = index;
    let depth = 1;
    let quote = null;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === '`') {
        quote = char;
      } else if (char === '[') {
        depth++;
      } else if (char === ']') {
        depth--;
      }
      if (depth > 0) index++;
    }
    // Only the string contents are CSS; the commas around them are not. All three quote
    // forms are in the tree — nine components write `styles: [':host { … }']` on one line
    // and one uses a template literal — and taking backticks alone found three of ten.
    const css = [
      ...source
        .slice(start, index)
        .matchAll(
          /`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g,
        ),
    ]
      .map(([, backtick, single, double]) => backtick ?? single ?? double ?? '')
      .join('\n');
    if (css.trim()) {
      blocks.push(css);
    }
  }
  return blocks;
}

/** Every component file declaring an inline `styles:` array, with that CSS folded together. */
export function inlineStyleSheets() {
  const found = [];
  for (const file of globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
    cwd: workspaceRoot,
  }).filter(
    (file) => !file.includes('node_modules') && !file.endsWith('.spec.ts'),
  )) {
    const blocks = inlineStylesOf(
      readFileSync(join(workspaceRoot, file), 'utf8'),
    );
    if (blocks.length) {
      found.push({ file, css: blocks.join('\n') });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}
