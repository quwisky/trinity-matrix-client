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
    const project = json('tools/docs/project.json');

    expect(project).toMatchObject({
      name: 'docs-site',
      projectType: 'library',
      root: 'tools/docs',
      tags: ['type:tool', 'scope:shared'],
    });
    expect(project.targets.check).toMatchObject({
      executor: 'nx:run-commands',
      dependsOn: [
        { projects: ['docs-users', 'docs-developers'], target: 'check' },
      ],
    });
    expect(project.targets.assemble).toMatchObject({
      executor: 'nx:run-commands',
      outputs: ['{workspaceRoot}/dist/docs-site'],
      dependsOn: expect.arrayContaining([
        { projects: ['docs-users', 'docs-developers'], target: 'build' },
      ]),
    });
  });

  it('pins the compatible Astro and Starlight toolchain', () => {
    const manifest = json('package.json');

    expect(manifest.devDependencies).toMatchObject({
      '@astrojs/check': '0.9.10',
      '@astrojs/markdown-remark': '7.3.1',
      '@astrojs/starlight': '0.42.0',
      astro: '7.3.2',
    });
  });
});

describe('documentation site presentation', () => {
  const userConfig = readFileSync(
    join(workspaceRoot, 'apps/docs-users/astro.config.mjs'),
    'utf8',
  );
  const developerConfig = readFileSync(
    join(workspaceRoot, 'apps/docs-developers/astro.config.mjs'),
    'utf8',
  );

  it('shares presentation without sharing public content', () => {
    for (const config of [userConfig, developerConfig]) {
      expect(config).toContain('@docs/shared-theme/trinity.css');
      expect(config).toContain('@docs/shared-components/ChannelBanner.astro');
      expect(config).toContain('@docs/shared-components/SiteFooter.astro');
      expect(config).toContain('@docs/shared-assets/trinity-mark.svg');
    }

    expect(userConfig).toContain("title: 'Trinity User Guide'");
    expect(userConfig).toContain("base: '/trinity-matrix-client/users'");
    expect(userConfig).not.toContain('apps/docs-developers/src/content');

    expect(developerConfig).toContain("title: 'Trinity Developer Guide'");
    expect(developerConfig).toContain(
      "base: '/trinity-matrix-client/developers'",
    );
    expect(developerConfig).not.toContain('apps/docs-users/src/content');
  });

  it('provides only the two audience destinations at the Pages root', () => {
    const portal = readFileSync(
      join(workspaceRoot, 'tools/docs/portal/index.html'),
      'utf8',
    );
    const destinations = [...portal.matchAll(/href="([^"]+)"/g)].map(
      ([, href]) => href,
    );

    expect(destinations).toEqual(['./users/', './developers/']);
    expect(portal).toContain('Trinity documentation');
  });
});
