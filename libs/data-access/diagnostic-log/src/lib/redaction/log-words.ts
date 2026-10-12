import { forEachWord } from './word-units';

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

  /** False only when some word of `name` never occurs in the log. */
  mayContain(name: string): boolean {
    let found = true;
    forEachWord(name, (hash, unspaced) => {
      found &&= unspaced || this.hashes.has(hash);
    });
    return found;
  }

  private addWords(text: string): void {
    forEachWord(text, (hash) => this.hashes.add(hash));
  }
}

/** `text` with URL escapes decoded: as UTF-8 where they form it, else byte by byte. */
function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(PERCENT_ESCAPE, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
}
