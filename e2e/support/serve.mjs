// Minimal static server with SPA fallback: serves files from `www/`, and returns
// index.html for any path without a file extension so deep links (e.g. /spike,
// /login) resolve to the Angular app instead of 404ing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function serve(root, port = 0, mounts = {}) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(
      new URL(req.url, 'http://localhost').pathname,
    );
    const mount = Object.entries(mounts).find(
      ([prefix]) => urlPath === prefix || urlPath.startsWith(`${prefix}/`),
    );
    const fileRoot = mount?.[1] ?? root;
    const mountedPath = mount ? urlPath.slice(mount[0].length) : urlPath;
    const ext = extname(mountedPath);
    // SPA fallback: paths without a file extension serve index.html as text/html.
    const isRoute = !ext;
    const absoluteRoot = resolve(fileRoot);
    const filePath = resolve(
      absoluteRoot,
      isRoute ? 'index.html' : mountedPath.replace(/^[/\\]+/, ''),
    );
    const contentType = isRoute
      ? 'text/html'
      : (MIME[ext] ?? 'application/octet-stream');
    if (
      filePath !== absoluteRoot &&
      !filePath.startsWith(`${absoluteRoot}${sep}`)
    ) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** Return the actual loopback origin selected by a listening server. */
export function serverOrigin(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Static E2E server has no TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}
