/**
 * Text a session chose for itself (its name, its device ID), made safe to show: control and
 * format characters, which include bidi overrides and zero-width characters, are removed,
 * and nothing left over means no text.
 */
export function displayText(value: string | null | undefined): string | null {
  return value?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() || null;
}

/**
 * A device ID to show, with anything invisible spelled out, so two different IDs never look the
 * same. Unlike {@link displayText} it hides nothing: a clone of `ABC` reads `ABC​`. The
 * backslash is escaped too, so typing that text out cannot match it.
 */
export function visibleId(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\\]|^\s+|\s+$/gu, (match) =>
    [...match]
      .map(
        (char) =>
          `\\u${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`,
      )
      .join(''),
  );
}
