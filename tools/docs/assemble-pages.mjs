import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArtifact } from './validation/artifact.mjs';

const asPath = (value) => (value instanceof URL ? fileURLToPath(value) : value);

const copyTree = (source, destination) => {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to copy symbolic link: ${source}.`);
  }
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source).sort()) {
      copyTree(join(source, entry), join(destination, entry));
    }
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
};

const assertControlledOutput = (outputRoot) => {
  const resolved = resolve(outputRoot);
  if (
    basename(resolved) !== 'docs-site' ||
    basename(dirname(resolved)) !== 'dist'
  ) {
    throw new Error(
      `Refusing uncontrolled documentation output path: ${resolved}.`,
    );
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Refusing symbolic output path: ${resolved}.`);
  }
  return resolved;
};

export const assemblePages = ({
  portalRoot,
  userRoot,
  developerRoot,
  outputRoot,
}) => {
  const output = assertControlledOutput(asPath(outputRoot));
  const portal = asPath(portalRoot);
  const users = asPath(userRoot);
  const developers = asPath(developerRoot);

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  copyTree(join(portal, 'index.html'), join(output, 'index.html'));
  copyTree(join(portal, '404.html'), join(output, '404.html'));
  copyTree(users, join(output, 'users'));
  copyTree(developers, join(output, 'developers'));
  validateArtifact(output);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
  assemblePages({
    portalRoot: join(workspaceRoot, 'tools/docs/portal'),
    userRoot: join(workspaceRoot, 'dist/docs/users'),
    developerRoot: join(workspaceRoot, 'dist/docs/developers'),
    outputRoot: join(workspaceRoot, 'dist/docs-site'),
  });
  console.log('Assembled Trinity documentation under dist/docs-site.');
}
