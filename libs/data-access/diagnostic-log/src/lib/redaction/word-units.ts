/** A letter, digit, mark or "_" of a script that separates words with spaces. */
export const SPACED_WORD = 1;
/** A letter, digit or mark of a script written without spaces (Han, kana, Thai, ...). */
export const UNSPACED_WORD = 2;
/** Anything else, including both halves of a surrogate pair. */
export const NOT_WORD = 3;

export type WordUnitClass =
  typeof SPACED_WORD | typeof UNSPACED_WORD | typeof NOT_WORD;

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
const UNSPACED_SCRIPT =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;

/** Classes by UTF-16 code unit, filled in as units are first seen; 0 is "not yet". */
let classes: Uint8Array | null = null;

/** How a UTF-16 code unit takes part in words. */
export function wordUnitClass(unit: number): WordUnitClass {
  classes ??= new Uint8Array(0x10000);
  let known = classes[unit];
  if (known === 0) {
    const character = String.fromCharCode(unit);
    known =
      (unit >= 0xd800 && unit <= 0xdfff) || !WORD_CHARACTER.test(character)
        ? NOT_WORD
        : UNSPACED_SCRIPT.test(character)
          ? UNSPACED_WORD
          : SPACED_WORD;
    classes[unit] = known;
  }
  return known as WordUnitClass;
}

/**
 * Calls `visit` for every word of `text` (a run of word units), lower-cased and in NFC, with
 * its 30-bit hash and whether it holds a unit of a script written without spaces.
 */
export function forEachWord(
  text: string,
  visit: (hash: number, unspaced: boolean, end: number) => void,
): void {
  let start = -1;
  let ascii = true;
  let unspaced = false;
  for (let index = 0; index <= text.length; index += 1) {
    const unit = index < text.length ? text.charCodeAt(index) : 0x20;
    const unitClass = wordUnitClass(unit);
    if (unitClass !== NOT_WORD) {
      if (start === -1) {
        start = index;
        ascii = true;
        unspaced = false;
      }
      ascii &&= unit < 0x80;
      unspaced ||= unitClass === UNSPACED_WORD;
      continue;
    }
    if (start !== -1) {
      visit(
        ascii
          ? asciiLowerHash(text, start, index)
          : stringHash(text.slice(start, index).toLowerCase().normalize('NFC')),
        unspaced,
        index,
      );
      start = -1;
    }
  }
}

// FNV-1a over UTF-16 code units, kept to 30 bits so the values stay small integers.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HASH_MASK = 0x3fffffff;

function asciiLowerHash(text: string, start: number, end: number): number {
  let hash = FNV_OFFSET;
  for (let index = start; index < end; index += 1) {
    let unit = text.charCodeAt(index);
    if (unit >= 0x41 && unit <= 0x5a) {
      unit += 0x20;
    }
    hash = Math.imul(hash ^ unit, FNV_PRIME);
  }
  return hash & HASH_MASK;
}

function stringHash(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME);
  }
  return hash & HASH_MASK;
}
