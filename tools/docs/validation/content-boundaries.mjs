import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_EXTENSIONS = new Set(['.md', '.mdx']);
const LINK = /(?<!!)\[[^\]]*\]\((?<target>[^)\s]+)(?:\s+[^)]*)?\)/g;
const IMPORT =
  /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](?<target>[^'"]+)['"]/g;
const EXTERNAL_URL = /^(?:https?:|mailto:|tel:|\/\/|#)/i;
const FORBIDDEN_PATH =
  /(?:^|[/\\])(?:\.agents|\.claude|docs-internal|dist)(?:[/\\]|$)|(?:^|[/\\])AGENTS\.md$|(?:^|[/\\])docs[/\\]superpowers(?:[/\\]|$)/i;

const asPath = (value) => (value instanceof URL ? fileURLToPath(value) : value);

const contentFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (PUBLIC_EXTENSIONS.has(extname(entry.name))) files.push(path);
    }
  };
  visit(root);
  return files.sort();
};

const within = (parent, candidate) => {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
};

const assertPublicTarget = (sourcePath, rawTarget) => {
  if (EXTERNAL_URL.test(rawTarget)) return;
  const pathname = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
  if (FORBIDDEN_PATH.test(pathname)) {
    throw new Error(
      `${sourcePath} links to internal documentation: ${rawTarget}.`,
    );
  }
};

export const validateContentBoundaries = ({ userRoot, developerRoot }) => {
  const roots = {
    user: asPath(userRoot),
    developer: asPath(developerRoot),
  };

  for (const [channel, root] of Object.entries(roots)) {
    for (const path of contentFiles(root)) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(LINK)) {
        assertPublicTarget(path, match.groups.target.replace(/^<|>$/g, ''));
      }
      for (const match of source.matchAll(IMPORT)) {
        const target = match.groups.target;
        assertPublicTarget(path, target);
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
        const resolved = resolve(join(path, '..'), target);
        const otherChannel = channel === 'user' ? 'developer' : 'user';
        if (within(roots[otherChannel], resolved)) {
          throw new Error(
            `${path} imports ${otherChannel} content instead of keeping public prose separate.`,
          );
        }
      }
    }
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  validateContentBoundaries({
    userRoot: join(workspaceRoot, 'apps/docs-users/src/content/docs'),
    developerRoot: join(workspaceRoot, 'apps/docs-developers/src/content/docs'),
  });
  console.log('Public documentation content boundaries are valid.');
}
