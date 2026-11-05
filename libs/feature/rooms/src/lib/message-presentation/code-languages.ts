import type { LanguageFn } from 'highlight.js';

export type { LanguageFn };

/** A highlight.js grammar and the chunk it loads from. */
export interface CodeLanguage {
  /** The highlight.js language id, which `highlightLines` takes. */
  readonly id: string;
  readonly load: () => Promise<{ default: LanguageFn }>;
}

// Each import path is a literal so the bundler gives every grammar its own chunk: a session
// downloads only the languages its messages use.
const LOADERS = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  go: () => import('highlight.js/lib/languages/go'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  shell: () => import('highlight.js/lib/languages/shell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
} satisfies Record<string, () => Promise<{ default: LanguageFn }>>;

type LanguageId = keyof typeof LOADERS;

/** Fence names and the aliases senders use, per highlight.js id. */
const FENCES: Record<LanguageId, readonly string[]> = {
  bash: ['bash', 'sh', 'zsh', 'shell', 'shellscript'],
  c: ['c', 'h'],
  csharp: ['csharp', 'cs'],
  css: ['css'],
  dart: ['dart'],
  diff: ['diff', 'patch'],
  dockerfile: ['dockerfile', 'docker'],
  go: ['go', 'golang'],
  ini: ['ini', 'toml'],
  java: ['java'],
  javascript: ['javascript', 'js', 'mjs', 'cjs', 'jsx'],
  json: ['json', 'jsonc'],
  kotlin: ['kotlin', 'kt', 'kts'],
  lua: ['lua'],
  makefile: ['makefile', 'make', 'mk'],
  markdown: ['markdown', 'md'],
  perl: ['perl', 'pl'],
  php: ['php'],
  powershell: ['powershell', 'ps1', 'pwsh'],
  python: ['python', 'py'],
  ruby: ['ruby', 'rb'],
  rust: ['rust', 'rs'],
  scala: ['scala'],
  // highlight.js `shell` is a console session (prompt and output); a shell script is `bash`.
  shell: ['shellsession', 'console'],
  sql: ['sql'],
  swift: ['swift'],
  typescript: ['typescript', 'ts', 'mts', 'cts', 'tsx'],
  xml: ['xml', 'html', 'htm', 'svg'],
  yaml: ['yaml', 'yml'],
};

export const CODE_LANGUAGES: ReadonlyMap<string, CodeLanguage> = new Map(
  (Object.keys(FENCES) as LanguageId[]).flatMap((id) => {
    const entry: CodeLanguage = { id, load: LOADERS[id] };
    return FENCES[id].map((fence) => [fence, entry] as const);
  }),
);

/** The grammar for a fence name, any case, or null when Trinity doesn't highlight it. */
export function resolveLanguage(fence: string): CodeLanguage | null {
  return CODE_LANGUAGES.get(fence.toLowerCase()) ?? null;
}
