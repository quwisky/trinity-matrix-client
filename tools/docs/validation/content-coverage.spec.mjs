import { parseFrontmatter } from '@astrojs/markdown-remark';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = new URL('../../../', import.meta.url).pathname;
const developerRoot = join(
  workspaceRoot,
  'apps/docs-developers/src/content/docs',
);

const routes = [
  'index',
  'start/prerequisites',
  'start/clone-and-install',
  'start/run-trinity',
  'start/repository-tour',
  'start/make-your-first-change',
  'architecture/system-overview',
  'architecture/capability-ownership',
  'architecture/dependency-boundaries',
  'architecture/state-and-reactivity',
  'architecture/matrix-integration',
  'architecture/encryption-and-trust',
  'architecture/workspace-and-navigation',
  'architecture/host-capabilities',
  'architecture/ui-and-theming',
  'development/angular-components',
  'development/signals-and-rxjs',
  'development/forms-and-validation',
  'development/data-access-services',
  'development/public-ui-components',
  'development/styling-and-responsive-ui',
  'development/matrix-features',
  'development/platform-integrations',
  'testing/testing-strategy',
  'testing/unit-tests',
  'testing/component-and-browser-tests',
  'testing/matrix-e2e-tests',
  'testing/desktop-and-native-tests',
  'testing/diagnose-failures',
  'platforms/web-and-pwa',
  'platforms/electron',
  'platforms/android',
  'platforms/ios',
  'contributing/choose-the-change-owner',
  'contributing/coding-conventions',
  'contributing/branches-and-commits',
  'contributing/validate-a-change',
  'contributing/prepare-a-pull-request',
  'contributing/write-documentation',
  'reference/technology-stack',
  'reference/commands',
  'reference/project-and-library-catalog',
  'reference/import-aliases',
  'reference/configuration',
  'reference/diagnostics',
  'reference/security-invariants',
];

const proceduralTestingRoutes = [
  'testing/unit-tests',
  'testing/component-and-browser-tests',
  'testing/matrix-e2e-tests',
  'testing/desktop-and-native-tests',
  'testing/diagnose-failures',
];

const page = (route) => {
  const path = join(developerRoot, `${route}.md`);
  const source = readFileSync(path, 'utf8');
  return { path, source, data: parseFrontmatter(source).frontmatter };
};

describe('developer documentation coverage', () => {
  it.each(routes)('publishes the %s route with channel metadata', (route) => {
    const { source, data } = page(route);

    expect(data.audience).toBe('developer');
    expect(data.contentChannel).toBe('develop');
    expect(data.canonicalTopic).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    expect(source).toMatch(/^#{2,6} .+ \{#[a-z][a-z0-9-]*\}\s*$/m);
  });

  it('assigns every route one unique canonical topic', () => {
    const topics = routes.map((route) => page(route).data.canonicalTopic);

    expect(new Set(topics).size).toBe(topics.length);
  });

  it.each(proceduralTestingRoutes)(
    'provides a runnable command on %s',
    (route) => {
      expect(page(route).source).toMatch(/```bash\n[^`]+\n```/);
    },
  );
});
