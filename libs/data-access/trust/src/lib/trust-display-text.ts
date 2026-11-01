/**
 * Text a session chose for itself (its name, its device ID), made safe to show: control and
 * format characters, which include bidi overrides and zero-width characters, are removed,
 * and nothing left over means no text.
 */
export function displayText(value: string | null | undefined): string | null {
  return value?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() || null;
}
