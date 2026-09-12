import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ALLOWED_KEYS = new Set(['status', 'version']);

/**
 * @typedef {{ status: 'unreleased', version: null } | { status: 'published', version: string }} ReleaseManifest
 */

/**
 * @param {string | URL} path
 * @returns {ReleaseManifest}
 */
export const readReleaseManifest = (path) => {
  let value;

  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read release manifest: ${error.message}`, {
      cause: error,
    });
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release manifest must be a JSON object.');
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => !ALLOWED_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Release manifest has unknown key: ${unknownKeys.join(', ')}.`,
    );
  }

  if (value.status === 'unreleased') {
    if (value.version !== null) {
      throw new Error(
        'An unreleased documentation site must have a null version.',
      );
    }
    return { status: 'unreleased', version: null };
  }

  if (value.status === 'published') {
    if (
      typeof value.version !== 'string' ||
      !SEMANTIC_VERSION.test(value.version)
    ) {
      throw new Error('A published release requires a semantic version.');
    }
    return { status: 'published', version: value.version };
  }

  throw new Error('Release manifest status must be unreleased or published.');
};

const markdownFiles = (root) => {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  const files = [];

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (['.md', '.mdx'].includes(extname(entry.name))) {
        files.push(relative(rootPath, path).split(sep).join('/'));
      }
    }
  };

  visit(rootPath);
  return files.sort();
};

/**
 * @param {string | URL} contentRoot
 * @param {ReleaseManifest} release
 */
export const validateUserContentState = (contentRoot, release) => {
  if (release.status !== 'unreleased') return;

  const files = markdownFiles(contentRoot);
  if (files.length !== 1 || files[0] !== 'index.md') {
    throw new Error(
      `Unreleased user documentation may contain only index.md; found ${files.join(', ') || 'no pages'}.`,
    );
  }
};
