// Minimal static server with SPA fallback: serves files from `www/`, and returns
// index.html for any path without a file extension so deep links (e.g. /spike,
// /login) resolve to the Angular app instead of 404ing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

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

export function serve(root, port) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(
      new URL(req.url, 'http://localhost').pathname,
    );
    const ext = extname(urlPath);
    // SPA fallback: paths without a file extension serve index.html as text/html.
    const isRoute = !ext;
    const filePath = isRoute
      ? join(root, 'index.html')
      : join(root, normalize(urlPath));
    const contentType = isRoute
      ? 'text/html'
      : (MIME[ext] ?? 'application/octet-stream');
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
