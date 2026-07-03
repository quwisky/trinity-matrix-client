import { protocol } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The custom *privileged* app scheme + file server for the Angular `www/` build.
 *
 * The build is served over a custom *privileged* scheme (registered as
 * standard + secure + fetch + stream) instead of raw `file://`, so that:
 *   - the renderer is a SECURE CONTEXT (required by WebCrypto SubtleCrypto and
 *     IndexedDB, which Matrix crypto + storage rely on),
 *   - the crypto WASM can be loaded with `WebAssembly.instantiateStreaming`
 *     (needs `Content-Type: application/wasm` + a streamable fetch Response),
 *   - `<base href="/">` and the app's absolute asset paths resolve cleanly,
 *   - the strict CSP in index.html (`'self'`) binds to a stable app origin.
 */

export const APP_SCHEME = 'trinity';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const START_URL = `${APP_ORIGIN}/`;

// In dev (compiled to electron/dist/main.js) and when packaged inside app.asar,
// the copied web build sits at electron/www (i.e. one level up from dist/).
// fs reads are asar-aware in Electron, so this path works in both cases.
export const WWW_ROOT = path.resolve(__dirname, '..', 'www');
export const INDEX_HTML = path.join(WWW_ROOT, 'index.html');

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeFor(filePath: string): string {
  return (
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
    'application/octet-stream'
  );
}

export async function fileResponse(
  filePath: string,
  status = 200,
): Promise<Response> {
  const data = await fs.promises.readFile(filePath);
  return new Response(new Uint8Array(data), {
    status,
    headers: { 'content-type': contentTypeFor(filePath) },
  });
}

/** True only for URLs on our own app origin (exact origin match, no prefix tricks). */
export function isAppUrl(url: string): boolean {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Custom-scheme file server for the Angular build.
 *
 * - Maps `<scheme>://app/<path>` -> `www/<path>` (so `/assets/...` ->
 *   `www/assets/...` and the crypto WASM is served as `application/wasm`).
 * - SPA fallback: extensionless paths (Angular client routes) serve index.html
 *   so a reload on e.g. `/rooms` boots the app instead of 404ing.
 * - Path-traversal hardened: a resolved path that escapes WWW_ROOT is rejected.
 */
export function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    let rel: string;
    try {
      const { pathname } = new URL(request.url);
      rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      // Malformed percent-encoding in the path (e.g. `%` or `%zz`) makes
      // decodeURIComponent throw — reject rather than crash the handler.
      return new Response('Bad Request', { status: 400 });
    }
    if (rel === '') {
      rel = 'index.html';
    }

    const resolved = path.normalize(path.join(WWW_ROOT, rel));
    if (resolved !== WWW_ROOT && !resolved.startsWith(WWW_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const stat = await fs.promises.stat(resolved);
      if (stat.isFile()) {
        return await fileResponse(resolved);
      }
    } catch {
      // fall through to SPA fallback / 404
    }

    // No file on disk: serve index.html for client routes (no extension),
    // otherwise it's a genuinely missing asset.
    if (path.extname(rel) === '') {
      return await fileResponse(INDEX_HTML);
    }
    return new Response('Not Found', { status: 404 });
  });
}

/**
 * Register the app scheme as privileged. MUST be called BEFORE the app is ready.
 * standard + secure => stable origin + secure context (WebCrypto/IndexedDB);
 * supportFetchAPI + stream => `fetch()` works and the WASM can stream-instantiate.
 */
export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}
