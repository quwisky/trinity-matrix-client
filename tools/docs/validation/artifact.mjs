import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_ROOTS = ['404.html', 'developers', 'index.html', 'users'];
const PAGES_BASE = '/trinity-matrix-client/';
const SECRET_NAME =
  /(?:^|[-_.])(?:secret|credential|token|id_rsa)(?:[-_.]|$)|(?:\.pem|\.key)$|^\.env(?:\.|$)/i;
const URL_ATTRIBUTE = /(?:href|src)="(?<url>[^"]+)"/g;
const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?|\.\.?\/)/i;

const asPath = (value) => (value instanceof URL ? fileURLToPath(value) : value);

const walk = (root) => {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Documentation artifact contains a symbolic link: ${path}.`,
        );
      }
      paths.push(path);
      if (stats.isDirectory()) visit(path);
    }
  };
  visit(root);
  return paths;
};

export const validateArtifact = (root) => {
  const rootPath = asPath(root);
  const rootStats = lstatSync(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Documentation artifact root must be a real directory.');
  }

  const roots = readdirSync(rootPath).sort();
  const unexpected = roots.filter((entry) => !EXPECTED_ROOTS.includes(entry));
  const missing = EXPECTED_ROOTS.filter((entry) => !roots.includes(entry));
  if (unexpected.length > 0) {
    throw new Error(
      `Documentation artifact has an unexpected top-level entry: ${unexpected.join(', ')}.`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Documentation artifact is missing top-level entry: ${missing.join(', ')}.`,
    );
  }

  for (const path of walk(rootPath)) {
    const relativePath = relative(rootPath, path).split(sep).join('/');
    const stats = lstatSync(path);
    if (stats.isDirectory()) continue;
    if (extname(path) === '.map') {
      throw new Error(
        `Documentation artifact contains a source map: ${relativePath}.`,
      );
    }
    if (SECRET_NAME.test(relativePath.split('/').at(-1))) {
      throw new Error(
        `Documentation artifact contains a secret-shaped filename: ${relativePath}.`,
      );
    }
    if (extname(path) !== '.html') continue;

    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(URL_ATTRIBUTE)) {
      const url = match.groups.url;
      if (EXTERNAL_URL.test(url)) continue;
      if (url.startsWith('/') && !url.startsWith(PAGES_BASE)) {
        throw new Error(
          `${relativePath} contains an invalid base URL: ${url}.`,
        );
      }
    }
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  validateArtifact(join(workspaceRoot, 'dist/docs-site'));
  console.log('Assembled documentation artifact is valid.');
}
