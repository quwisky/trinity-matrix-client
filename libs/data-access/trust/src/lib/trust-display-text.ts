/**
 * Text a session chose for itself (its name, its device ID), made safe to show: control and
 * format characters, which include bidi overrides and zero-width characters, are removed,
 * and nothing left over means no text.
 */
export function displayText(value: string | null | undefined): string | null {
  return value?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() || null;
}

/**
 * A device ID to show, with everything but printable ASCII spelled out as `\u{...}`. Different IDs
 * always read differently: invisible characters and lookalikes such as Cyrillic `А` cannot pass
 * for another ID, and the backslash is escaped so typing the escaped form out cannot match it.
 */
export function visibleId(value: string): string {
  return value.replace(
    /[^\x21-\x5B\x5D-\x7E]/gu,
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}
