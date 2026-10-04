import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Remove Matrix identifiers, access tokens and passwords from artifact text. Appium's
 * `[SafariConsole]` lines keep their text (all E2E data is synthetic, and they are the only
 * view of app-side errors): only the id and token rules apply there.
 */
export function scrub(text: string): string {
  return text
    .split('\n')
    .map((line) => scrubLine(line, line.includes('[SafariConsole]')))
    .join('\n');
}

function scrubLine(text: string, keepTyped: boolean): string {
  const ids = text
    .replace(/@[a-z0-9._=\-/]+:[a-z0-9.\-]+(:\d+)?/gi, '@<user>')
    .replace(/![A-Za-z0-9]+:[a-z0-9.\-]+(:\d+)?/g, '!<room>')
    // URL-encoded ids in request paths: %40user%3Aserver, %21room%3Aserver.
    .replace(/%40[^%\s/"&]+%3A[a-z0-9.\-]+(%3A\d+)?/gi, '%40<user>')
    .replace(/%21[^%\s/"&]+%3A[a-z0-9.\-]+(%3A\d+)?/gi, '%21<room>')
    .replace(/\$[A-Za-z0-9_\-]{20,}/g, '$<event>')
    .replace(/syt_[A-Za-z0-9_]+/g, '<token>')
    .replace(/(\\?"password\\?"\s*:\s*\\?")[^"\\]*/g, '$1<redacted>');
  if (keepTyped) return ids;
  return (
    ids
      // Text typed into the WebView (usernames, passwords) travels as {"text":"..."}.
      .replace(/(\\?"text\\?"\s*:\s*\\?")[^"\\]*/g, '$1<typed>')
      // ...and as {"value":["a","b",...]}, one character per element.
      .replace(/("value"\s*:\s*\[)(?:"[^"]",?)+/g, '$1"<typed>"')
  );
}

/** Scrub every text artifact (.log, .xml, .txt, .json, .html) under a directory, in place. */
export function scrubDirectory(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.(log|xml|txt|json|html)$/u.test(entry.name))
      continue;
    const file = join(entry.parentPath, entry.name);
    writeFileSync(file, scrub(readFileSync(file, 'utf8')));
  }
}
