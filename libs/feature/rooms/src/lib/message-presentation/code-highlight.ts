import {
  createHighlighterCoreSync,
  type HighlighterCore,
  type ThemeRegistrationRaw,
} from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import bash from '@shikijs/langs/bash';
import css from '@shikijs/langs/css';
import diff from '@shikijs/langs/diff';
import go from '@shikijs/langs/go';
import java from '@shikijs/langs/java';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import python from '@shikijs/langs/python';
import rust from '@shikijs/langs/rust';
import sql from '@shikijs/langs/sql';
import typescript from '@shikijs/langs/typescript';
import xml from '@shikijs/langs/xml';
import yaml from '@shikijs/langs/yaml';
import c from '@shikijs/langs/c';
import csharp from '@shikijs/langs/csharp';
import dart from '@shikijs/langs/dart';
import dockerfile from '@shikijs/langs/dockerfile';
import html from '@shikijs/langs/html';
import ini from '@shikijs/langs/ini';
import kotlin from '@shikijs/langs/kotlin';
import lua from '@shikijs/langs/lua';
import makefile from '@shikijs/langs/makefile';
import markdown from '@shikijs/langs/markdown';
import perl from '@shikijs/langs/perl';
import php from '@shikijs/langs/php';
import powershell from '@shikijs/langs/powershell';
import ruby from '@shikijs/langs/ruby';
import scala from '@shikijs/langs/scala';
import shellsession from '@shikijs/langs/shellsession';
import swift from '@shikijs/langs/swift';
import toml from '@shikijs/langs/toml';

/**
 * Syntax highlighting for fenced code blocks, applied at the render leaf by CodeHighlightDirective.
 *
 * Never imported statically: the directive loads this module with a dynamic `import()` the first
 * time a rendered message holds a fenced block with a language. `@shikijs/langs` is ~2.7 MB minified
 * (78 % of the rooms chunk), so a room without code never downloads it.
 */

/**
 * The token roles we colour. Deliberately small: each is a colour a Theme author must choose, while
 * TextMate scopes are effectively unbounded. Mapped scope-family to role, so it stays stable across grammars.
 *
 * Keep in step with the `--trinity-syntax-*` roles in Theme Foundation.
 */
const TOKEN_ROLES = [
  'keyword',
  'string',
  'number',
  'comment',
  'function',
  'type',
  'variable',
  'punctuation',
] as const;

type TokenRole = (typeof TOKEN_ROLES)[number];

// Shiki has no class-based output mode: `createCssVariablesTheme` emits inline `style`, and Angular's
// [innerHTML] sanitizer drops `style` at the render leaf. So the theme carries a sentinel "colour" per
// role which we translate back into a class name. Keyed by ROLE NAME, not position: THEME lists them in
// scope-precedence order, so an index lookup would let inserting a role silently recolour every token.
const SENTINEL = Object.fromEntries(
  TOKEN_ROLES.map((role, i) => [
    role,
    `#${(i + 1).toString(16).padStart(6, '0')}`,
  ]),
) as Record<TokenRole, string>;

const ROLE_BY_SENTINEL = new Map(
  TOKEN_ROLES.map((role) => [SENTINEL[role].toLowerCase(), `tok-${role}`]),
);

const THEME_NAME = 'trinity-tokens';

// Order matters: vscode-textmate resolves equally specific selectors to the LAST match, and a more
// specific scope always wins. `storage.type` sits with the keywords on purpose (Python's `def`,
// TypeScript's `const`); under the type role `def` would render as a type.
const THEME: ThemeRegistrationRaw = {
  name: THEME_NAME,
  settings: [
    // Default: no class, so the token simply inherits the <pre> colour.
    { settings: { foreground: '#000000' } },
    {
      scope: ['punctuation', 'meta.brace', 'punctuation.separator'],
      settings: { foreground: SENTINEL.punctuation },
    },
    {
      scope: ['variable', 'variable.other', 'entity.name.variable'],
      settings: { foreground: SENTINEL.variable },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.type',
        'support.class',
        'entity.name.tag',
      ],
      settings: { foreground: SENTINEL.type },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call',
        'variable.function',
      ],
      settings: { foreground: SENTINEL.function },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character'],
      settings: { foreground: SENTINEL.number },
    },
    {
      scope: ['string', 'string.quoted', 'string.regexp'],
      settings: { foreground: SENTINEL.string },
    },
    {
      scope: [
        'keyword',
        'keyword.control',
        'keyword.operator',
        'storage',
        'storage.type',
        'storage.modifier',
      ],
      settings: { foreground: SENTINEL.keyword },
    },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      // The one rule that sets a font style, so `classFor` below has something to read.
      settings: { foreground: SENTINEL.comment, fontStyle: 'italic' },
    },
  ],
};

// vscode-textmate FontStyle bit flags; @shikijs/core does not re-export them. Only styles some rule
// above sets are mapped: a flag no rule produces would be dead code that reads as supported.
const FONT_ITALIC = 1;

/**
 * Ceiling on what we will tokenize. Highlighting runs synchronously on the main thread and a sender
 * can put a 60 KiB fenced block in every event. Past the cap the block renders as plain monospace.
 */
export const MAX_CODE_CHARS = 4_096;

let highlighter: HighlighterCore | null = null;
// Latched on the first construction failure; otherwise a throwing constructor would be retried for
// every code block in every message.
let unavailable = false;

/** Built on first use: the grammars are compiled lazily per rule by vscode-textmate. */
function instance(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [THEME],
    langs: [
      bash,
      c,
      csharp,
      css,
      dart,
      diff,
      dockerfile,
      go,
      html,
      ini,
      java,
      javascript,
      json,
      kotlin,
      lua,
      makefile,
      markdown,
      perl,
      php,
      powershell,
      python,
      ruby,
      rust,
      scala,
      shellsession,
      sql,
      swift,
      toml,
      typescript,
      xml,
      yaml,
    ],
    // The pure-JS RegExp engine: no WASM binary to ship, host or allow through the CSP. `target: 'auto'`
    // feature-detects, so patterns stay legal down to our browserslist floor (Safari 16.4); `forgiving`
    // skips the few Oniguruma constructs it cannot express rather than throwing mid-render.
    engine: createJavaScriptRegexEngine({ target: 'auto', forgiving: true }),
  });
  return highlighter;
}

/** The class list for one token, or '' when it should stay unstyled. */
function classFor(
  colour: string | undefined,
  fontStyle: number | undefined,
): string {
  const role = colour ? ROLE_BY_SENTINEL.get(colour.toLowerCase()) : undefined;
  return [
    ...(role ? [role] : []),
    ...((fontStyle ?? 0) & FONT_ITALIC ? ['tok-italic'] : []),
  ].join(' ');
}

/**
 * Tokenize `code` into one fragment per line of `<span class="tok-*">` runs, or null when the language
 * is unknown, the block is oversized, or the grammar fails. No token spans a newline, so a caller may
 * wrap each fragment in its own line.
 *
 * Built with createElement/createTextNode, never innerHTML: no string of ours can become markup, so
 * this cannot reintroduce anything DOMPurify has just removed.
 */
export function highlightLines(
  code: string,
  lang: string,
  doc: Document,
): DocumentFragment[] | null {
  if (unavailable || code.length > MAX_CODE_CHARS) {
    return null;
  }
  let lines;
  try {
    // Construction and language lookup are INSIDE the guard: a highlighter that cannot be built must
    // degrade to plain code, not throw at render.
    const shiki = instance();
    if (!shiki.getLoadedLanguages().includes(lang)) {
      return null;
    }
    lines = shiki.codeToTokens(code, { lang, theme: THEME_NAME }).tokens;
  } catch {
    // A grammar tripping over one input degrades that block; a highlighter that cannot be built at all
    // disables highlighting for the session rather than retrying per message.
    unavailable = highlighter === null;
    return null;
  }
  return lines.map((line) => {
    const fragment = doc.createDocumentFragment();
    for (const token of line) {
      const className = classFor(token.color, token.fontStyle);
      if (!className) {
        fragment.appendChild(doc.createTextNode(token.content));
        continue;
      }
      const span = doc.createElement('span');
      span.className = className;
      span.textContent = token.content;
      fragment.appendChild(span);
    }
    return fragment;
  });
}
