import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

const json = (relativePath) =>
  JSON.parse(readFileSync(join(workspaceRoot, relativePath), 'utf8'));

describe('documentation site projects', () => {
  it.each([
    ['docs-users', 'apps/docs-users', 'dist/docs/users'],
    ['docs-developers', 'apps/docs-developers', 'dist/docs/developers'],
  ])(
    'registers the %s Starlight application with an independent output',
    (name, root, output) => {
      const project = json(`${root}/project.json`);

      expect(project).toMatchObject({
        name,
        projectType: 'application',
        root,
        sourceRoot: `${root}/src`,
        tags: ['type:tool', 'scope:shared'],
      });
      expect(project.targets).toMatchObject({
        serve: {
          executor: 'nx:run-commands',
          options: { command: 'astro dev', cwd: `{workspaceRoot}/${root}` },
        },
        build: {
          executor: 'nx:run-commands',
          outputs: [`{workspaceRoot}/${output}`],
          options: { command: 'astro build', cwd: `{workspaceRoot}/${root}` },
        },
        check: {
          executor: 'nx:run-commands',
          options: { command: 'astro check', cwd: `{workspaceRoot}/${root}` },
        },
      });
    },
  );

  it('registers shared documentation tooling separately from public content', () => {
    expect(json('tools/docs/project.json')).toMatchObject({
      name: 'docs-site',
      projectType: 'library',
      root: 'tools/docs',
      tags: ['type:tool', 'scope:shared'],
    });
  });

  it('pins the compatible Astro and Starlight toolchain', () => {
    const manifest = json('package.json');

    expect(manifest.devDependencies).toMatchObject({
      '@astrojs/check': '0.9.10',
      '@astrojs/starlight': '0.42.0',
      astro: '7.3.2',
    });
  });
});
