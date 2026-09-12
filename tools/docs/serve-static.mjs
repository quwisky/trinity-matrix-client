#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const rootArgument = option('root');
const baseArgument = option('base');
const port = Number(option('port'));

if (!rootArgument || !baseArgument || !Number.isInteger(port)) {
  throw new Error(
    'Usage: serve-static --root <directory> --base </path> --port <port>',
  );
}

const root = resolve(rootArgument);
const base = baseArgument.replace(/\/$/, '');
if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error(`Static root is not a directory: ${root}`);
}
if (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(base) || base.includes('..')) {
  throw new Error(`Static base is invalid: ${baseArgument}`);
}
if (port < 1 || port > 65_535) {
  throw new Error(`Static port is invalid: ${String(port)}`);
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

const withinRoot = (path) => path === root || path.startsWith(`${root}${sep}`);
const sendFile = (response, path, status) => {
  response.writeHead(status, {
    'Content-Type':
      contentTypes.get(extname(path)) ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(path).pipe(response);
};

const notFound = (response) =>
  sendFile(response, resolve(root, '404.html'), 404);

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    );
  } catch {
    notFound(response);
    return;
  }

  if (
    pathname.includes('\0') ||
    pathname.includes('\\') ||
    (pathname !== base && !pathname.startsWith(`${base}/`))
  ) {
    notFound(response);
    return;
  }

  const route = pathname.slice(base.length) || '/';
  const segments = route.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    notFound(response);
    return;
  }

  const relativePath = route.endsWith('/')
    ? `${route.slice(1)}index.html`
    : route.slice(1);
  const requestedPath = resolve(root, relativePath);
  if (
    !withinRoot(requestedPath) ||
    !existsSync(requestedPath) ||
    !statSync(requestedPath).isFile()
  ) {
    notFound(response);
    return;
  }

  if (request.method === 'HEAD') {
    response.writeHead(200, {
      'Content-Type':
        contentTypes.get(extname(requestedPath)) ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end();
    return;
  }
  sendFile(response, requestedPath, 200);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Serving ${root} at http://127.0.0.1:${port}${base}/\n`);
});

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
