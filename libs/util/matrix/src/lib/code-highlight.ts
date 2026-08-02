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
import { setCodeHighlighter } from './message-view';

/**
 * Synchronous syntax highlighting for fenced code blocks in rendered Matrix HTML.
 *
 * **Not exported from the `@trinity/util-matrix` barrel**, and reachable only through the
 * `@trinity/util-matrix/code-highlight` path alias. That is load-bearing: `message-view.ts`
 * sits in the app's eager chunk, so a barrel export would put every grammar in the initial
 * bundle. Importing this module from the lazily-loaded rooms route puts it in the rooms
 * chunk instead. The module registers itself on evaluation, which happens before any
 * message view is projected, so highlighting is available for the first paint and the
 * render path stays entirely synchronous.
 *
 * **Cost, stated plainly:** the grammars are static imports, roughly 813 KB raw / 134 kB
 * gzipped, and they are downloaded and parsed with the rooms chunk whether or not any
 * message contains code. Only grammar *compilation* is deferred to first use. Making the
 * download conditional means a dynamic `import()` on the first fenced block, which turns
 * highlighting async — and because the timeline's view and row caches key on event
 * revision and object identity, a late install would leave already-projected messages
 * unhighlighted until something else invalidated them. Doing it properly needs a
 * generation counter threaded into those caches, which is why it is not done here.
 */

/**
 * The token roles we colour. Deliberately small: each one is a colour a palette author has
 * to choose, while TextMate scopes are effectively unbounded. The mapping is scope-family →
 * role rather than theme-colour → role, so it stays stable across grammars.
 *
 * Keep in step with the `--trinity-syntax-*` tokens in `apps/trinity/src/theme/variables.scss`.
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

// Shiki has no class-based output mode: `createCssVariablesTheme` emits inline `style`, and
// Angular's [innerHTML] sanitizer drops `style` outright at the render leaf. So the theme
// carries a sentinel "colour" per role which we translate straight back into a class name.
//
// Keyed by ROLE NAME, not by position: THEME below references these in scope-precedence
// order rather than TOKEN_ROLES order, so an index-based lookup would let inserting a role
// silently recolour every token — with nothing to fail.
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

// Order matters: vscode-textmate resolves equally specific selectors in favour of the LAST
// match, and a more specific scope always wins. `storage.type` sits with the keywords on
// purpose — it is Python's `def` and TypeScript's `const`, which read as keywords; listing
// it under the type role instead makes `def` render as a type.
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

// vscode-textmate FontStyle bit flags; @shikijs/core does not re-export them. Only the
// styles some rule above actually sets are worth mapping — a flag no rule produces would
// be dead code that reads as a supported feature.
const FONT_ITALIC = 1;

/**
 * Ceiling on what we will tokenize. Highlighting runs synchronously inside the timeline
 * projection, and a sender can put a 60 KiB fenced block in every event — an uncapped
 * grammar pass over a page of backscroll is a trivial main-thread freeze. Past the cap the
 * block still renders, just as plain monospace.
 */
const MAX_CODE_CHARS = 6_000;

let highlighter: HighlighterCore | null = null;
// Latched on the first construction failure. Without it a throwing constructor would be
// retried — and re-thrown — for every code block in every message, forever.
let unavailable = false;

/**
 * Built on first use rather than at module load: the grammars are compiled lazily per rule
 * by vscode-textmate, so a room whose messages contain no code block never compiles one.
 * (The grammar JSON is still downloaded and parsed with this chunk — see the note at the
 * top of the file.)
 */
function instance(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [THEME],
    langs: [
      bash,
      css,
      diff,
      go,
      java,
      javascript,
      json,
      python,
      rust,
      sql,
      typescript,
      xml,
      yaml,
    ],
    // The pure-JS RegExp engine: no WASM binary to ship, host or allow through the CSP.
    // `target: 'auto'` feature-detects, so the emitted patterns stay legal down to our
    // browserslist floor (Safari 16.4); `forgiving` skips the few Oniguruma constructs it
    // cannot express rather than throwing mid-render.
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
 * Tokenize `code` into `<span class="tok-*">` runs, or null when the language is unknown,
 * the block is oversized, or the grammar fails.
 *
 * Built with createElement/createTextNode, never innerHTML — no string of ours can become
 * markup, so this cannot reintroduce anything DOMPurify has just removed.
 */
function highlight(
  code: string,
  lang: string,
  doc: Document,
): DocumentFragment | null {
  if (unavailable || code.length > MAX_CODE_CHARS) {
    return null;
  }
  let lines;
  try {
    // Construction and language lookup are INSIDE the guard, not just tokenization: if
    // `createHighlighterCoreSync` throws (an engine the browser rejects, a grammar that
    // fails to load) the throw would otherwise escape through sanitizeMatrixHtml into
    // buildMessageView, where safeBuildMessageView turns the whole message into an
    // "unsupported" placeholder — losing its text rather than just its colours.
    const shiki = instance();
    if (!shiki.getLoadedLanguages().includes(lang)) {
      return null;
    }
    lines = shiki.codeToTokens(code, { lang, theme: THEME_NAME }).tokens;
  } catch {
    // A grammar tripping over one input degrades that block; a highlighter that cannot be
    // built at all disables highlighting for the session rather than retrying per message.
    unavailable = highlighter === null;
    return null;
  }
  const fragment = doc.createDocumentFragment();
  lines.forEach((line, index) => {
    if (index > 0) {
      fragment.appendChild(doc.createTextNode('\n'));
    }
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
  });
  return fragment;
}

// Registered by importing this module — there is no exported entry point on purpose, so
// there is exactly one way in and no second call that would needlessly clear the memo.
setCodeHighlighter(highlight);
