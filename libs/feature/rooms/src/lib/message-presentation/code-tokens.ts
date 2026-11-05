/**
 * The token roles we colour. Deliberately small: each is a colour a Theme author must choose.
 *
 * Keep in step with the `--trinity-syntax-*` roles in Theme Foundation.
 */
export type TokenRole =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'variable'
  | 'punctuation';

/**
 * Ceiling on what we will tokenize: a sender can put a 60 KiB fenced block in every event. Past
 * the cap the block renders as plain monospace.
 */
export const MAX_CODE_CHARS = 4_096;

/** One minified line can cost more than many short ones; past this, the block stays plain. */
export const MAX_LINE_CHARS = 1_000;

/** Whether a block is worth tokenizing: not blank and within both caps. */
export function fitsCaps(code: string): boolean {
  return (
    code.trim() !== '' &&
    code.length <= MAX_CODE_CHARS &&
    code.split('\n').every((line) => line.length <= MAX_LINE_CHARS)
  );
}

/** One run of text and the role it is coloured with; null leaves it uncoloured. */
export type Run = readonly [text: string, role: TokenRole | null];

const SCOPE_ROLES: readonly (readonly [string, TokenRole])[] = [
  ['hljs-keyword', 'keyword'],
  ['hljs-built_in', 'keyword'],
  ['hljs-literal', 'keyword'],
  ['hljs-string', 'string'],
  ['hljs-regexp', 'string'],
  ['hljs-link', 'string'],
  ['hljs-number', 'number'],
  ['hljs-comment', 'comment'],
  ['hljs-type', 'type'],
  ['hljs-tag', 'type'],
  ['hljs-name', 'type'],
  ['hljs-section', 'type'],
  ['hljs-variable', 'variable'],
  ['hljs-params', 'variable'],
  ['hljs-attr', 'variable'],
  ['hljs-attribute', 'variable'],
  ['hljs-punctuation', 'punctuation'],
  ['hljs-operator', 'punctuation'],
  ['hljs-bullet', 'punctuation'],
];

/** The role a highlight.js scope span carries, or null for scopes we leave uncoloured. */
export function roleOfClasses(classes: readonly string[]): TokenRole | null {
  if (classes.includes('hljs-title')) {
    if (classes.includes('function_')) return 'function';
    if (classes.includes('class_')) return 'type';
    return null;
  }
  return SCOPE_ROLES.find(([scope]) => classes.includes(scope))?.[1] ?? null;
}

const OPEN = '<span class="';
const CLOSE = '</span>';
const ESCAPES: readonly (readonly [string, string])[] = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#x27;', "'"],
];

/**
 * highlight.js markup as runs per line, or null for anything it would not emit: only
 * `<span class="…">`, `</span>` and its five escapes are accepted. Needs no DOM, so the same
 * code runs in the worker and on the main thread; the caller still checks the text against the
 * source before showing it.
 */
export function tokenize(html: string): Run[][] | null {
  const lines: Run[][] = [[]];
  const roles: (TokenRole | null)[] = [];
  let pending = '';

  const flush = (): void => {
    if (!pending) return;
    const role = roles.at(-1) ?? null;
    const line = lines[lines.length - 1];
    const last = line.at(-1);
    if (last && last[1] === role) {
      line[line.length - 1] = [last[0] + pending, role];
    } else {
      line.push([pending, role]);
    }
    pending = '';
  };

  let i = 0;
  while (i < html.length) {
    const char = html[i];
    if (char === '<') {
      flush();
      if (html.startsWith(OPEN, i)) {
        const end = html.indexOf('">', i + OPEN.length);
        const value = end < 0 ? '' : html.slice(i + OPEN.length, end);
        if (end < 0 || /["<>&]/u.test(value)) return null;
        roles.push(roleOfClasses(value.split(' ')) ?? roles.at(-1) ?? null);
        i = end + 2;
      } else if (html.startsWith(CLOSE, i)) {
        if (roles.length === 0) return null;
        roles.pop();
        i += CLOSE.length;
      } else {
        return null;
      }
    } else if (char === '&') {
      const escape = ESCAPES.find(([entity]) => html.startsWith(entity, i));
      if (!escape) return null;
      pending += escape[1];
      i += escape[0].length;
    } else if (char === '\n') {
      flush();
      lines.push([]);
      i += 1;
    } else {
      pending += char;
      i += 1;
    }
  }
  flush();
  return roles.length === 0 ? lines : null;
}
