import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
/** The YAML block of one job: from its key to the next top-level job key. */
const job = (workflow, name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const end = rest.slice(1).search(/\n  [a-z][a-z-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

describe('release workflow web zip', () => {
  const release = read('.github/workflows/release.yml');

  it('builds, records and packs the verified renderer for the tag', () => {
    const web = job(release, 'package-web');
    expect(web).toContain('needs: verify');
    expect(web).toContain("needs.verify.result == 'success'");
    expect(web).toContain('pnpm nx run trinity:build');
    expect(web).toContain('node scripts/web-bundle-manifest.mjs write www');
    expect(web).toMatch(
      /node scripts\/web-release-zip\.mjs --version "\$\{TAG#v\}" --out release-web/,
    );
    expect(web).toContain('name: trinity-web');
    expect(web).toContain('path: release-web/Trinity-Web-*.zip');
  });

  it('waits for the web zip and names it in a partial-release warning', () => {
    const draft = job(release, 'draft-release');
    expect(draft).toMatch(/needs: \[verify, package, package-web\]/);
    expect(draft).toContain(
      'ls artifacts/Trinity-Web-*.zip >/dev/null 2>&1 || missing="$missing web"',
    );
  });
});

describe('container workflow', () => {
  const container = read('.github/workflows/container.yml');

  it('runs only for published releases or an explicit republish', () => {
    expect(container).toMatch(
      /on:\n  release:\n    types: \[published\]\n  workflow_dispatch:/,
    );
    expect(container).toContain('group: container');
    expect(container).toContain('cancel-in-progress: false');
    expect(container).toMatch(/permissions:\n  contents: read\n/);
    expect(container).toMatch(
      /permissions:\n      contents: read\n      packages: write/,
    );
  });

  it('fails clearly without the web zip and verifies before any login or push', () => {
    expect(container).toContain('::error::$TAG has no $ASSET release asset');
    const order = [
      'gh release download',
      'node scripts/web-bundle-manifest.mjs verify dist/web-bundle-manifest.json www',
      'pnpm nx run trinity-web-container:smoke',
      'docker/login-action@',
      'docker buildx build',
    ].map((marker) => container.indexOf(marker));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('pushes both architectures to GHCR with computed tags and OCI labels', () => {
    expect(container).toContain('IMAGE: ghcr.io/quwisky/trinity-web');
    expect(container).toContain('--platform linux/amd64,linux/arm64');
    expect(container).toContain('--push');
    expect(container).toContain('node scripts/web-image-tags.mjs --tag "$TAG"');
    expect(container).toContain('node scripts/web-container.mjs stage');
    for (const label of ['version', 'revision', 'source', 'created'])
      expect(container).toContain(`--label org.opencontainers.image.${label}=`);
    expect(container).not.toContain('setup-qemu-action');
  });
});
