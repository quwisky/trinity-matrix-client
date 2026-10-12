import { forEachWord } from './word-units';

const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g;
const JSON_ESCAPE = /\\(?:u([0-9A-Fa-f]{4})|(["\\/bfnrt]))/g;
const JSON_SIMPLE: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * The words a log contains, as 30-bit hashes of their lower-cased NFC form, so a name can be
 * ruled out without keeping the text. A name whose space-separated words are not all here
 * cannot occur in the log as whole words in any spelling the redactor matches: raw, with its
 * identifiers redacted (the other words survive), escaped for JSON or a URL (both decoded
 * here too), or decomposed (words are compared in NFC). Words of scripts written without
 * spaces are not checked: they can occur inside a longer run.
 */
export class LogWords {
  private readonly hashes = new Set<number>();

  add(line: string): void {
    this.addWords(line);
    if (line.includes('%')) {
      this.addWords(percentDecoded(line));
    }
    if (line.includes('\\')) {
      this.addWords(
        line.replace(
          JSON_ESCAPE,
          (_escape, hex: string | undefined, simple: string | undefined) =>
            hex
              ? String.fromCharCode(Number.parseInt(hex, 16))
              : (JSON_SIMPLE[simple ?? ''] ?? ''),
        ),
      );
    }
  }

  /**
   * False only when some word of `text` never occurs in the log. With `cutEnd`, `text` is
   * the start of something longer, so a word running into its end may be cut and is not
   * checked.
   */
  mayContain(text: string, cutEnd = false): boolean {
    let found = true;
    forEachWord(text, (hash, unspaced, end) => {
      found &&=
        unspaced || (cutEnd && end === text.length) || this.hashes.has(hash);
    });
    return found;
  }

  private addWords(text: string): void {
    forEachWord(text, (hash) => this.hashes.add(hash));
  }
}

/**
 * `text` with URL escapes decoded, each run of them on its own so that a stray "%" elsewhere
 * does not stop the rest: as UTF-8 where a run forms it, else byte by byte.
 */
function percentDecoded(text: string): string {
  return text.replace(PERCENT_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(PERCENT_ESCAPE, (_escape, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });
}
