import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

describe('legacy documentation replacement', () => {
  it.each([
    'README.md',
    'AGENTS.md',
    'CONTEXT.md',
    '.agents/README.md',
    '.agents/skill-overrides.md',
    '.claude/CLAUDE.md',
    '.claude/README.md',
    'e2e/README.md',
    'e2e/web/production-renderer/README.md',
    'libs/components/storybook-host/README.md',
  ])('does not route %s through the superseded docs tree', (path) => {
    const source = readFileSync(join(workspaceRoot, path), 'utf8');

    expect(source).not.toMatch(
      /(?:^|[\s(])(?:\.\.\/)*docs\/(?:users|contributing|architecture|platforms|reference|agents|maintaining|adr)(?:\/|\))/m,
    );
  });

  it('keeps internal and instruction roots out of public build inputs', () => {
    for (const projectPath of [
      'apps/docs-users/project.json',
      'apps/docs-developers/project.json',
      'tools/docs/project.json',
    ]) {
      const source = readFileSync(join(workspaceRoot, projectPath), 'utf8');
      expect(source).not.toMatch(/docs-internal|\.agents|\.claude/);
    }
  });
});

describe('GitHub Pages documentation publication', () => {
  const workflowPath = join(workspaceRoot, '.github/workflows/docs-pages.yml');
  const workflow = () => parse(readFileSync(workflowPath, 'utf8'));

  it('defines a dedicated develop and manual Pages workflow', () => {
    expect(existsSync(workflowPath)).toBe(true);
    expect(workflow().on).toEqual({
      push: { branches: ['develop'] },
      workflow_dispatch: null,
    });
    expect(workflow().permissions).toEqual({ contents: 'read' });
  });

  it('validates, assembles, and uploads exactly one Pages artifact', () => {
    const build = workflow().jobs.build;
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(build.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual(
      [
        'pnpm format:check',
        'pnpm nx test scripts',
        'pnpm nx test docs-site',
        'pnpm nx run docs-site:check',
        'pnpm nx run docs-site:assemble',
        'pnpm nx run docs-site:e2e',
      ],
    );

    const configured = build.steps.filter((step) =>
      step.uses?.startsWith('actions/configure-pages@'),
    );
    const uploads = build.steps.filter((step) =>
      step.uses?.startsWith('actions/upload-pages-artifact@'),
    );
    expect(configured).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].with).toEqual({ path: 'dist/docs-site' });
    const remoteActions = build.steps.filter(
      (step) => step.uses && !step.uses.startsWith('./'),
    );
    for (const step of remoteActions) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('deploys only develop through a least-privilege protected job', () => {
    const deploy = workflow().jobs.deploy;
    expect(deploy.needs).toBe('build');
    expect(deploy.if).toContain("github.ref == 'refs/heads/develop'");
    expect(deploy.permissions).toEqual({
      pages: 'write',
      'id-token': 'write',
    });
    expect(deploy.environment).toEqual({
      name: 'github-pages',
      url: '${{ steps.deployment.outputs.page_url }}',
    });
    const deployment = deploy.steps.filter((step) =>
      step.uses?.startsWith('actions/deploy-pages@'),
    );
    expect(deployment).toHaveLength(1);
    expect(deployment[0].id).toBe('deployment');
    expect(deployment[0].uses).toMatch(/@[0-9a-f]{40}$/);
  });
});
