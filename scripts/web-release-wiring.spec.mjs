import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
    expect(draft).toMatch(/needs: \[verify, package, sign-mac, package-web\]/);
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

describe('web release docs', () => {
  const guide = read('docs-internal/maintenance/ci-and-releases.md');
  const readme = read('README.md');

  it('describe the shipped flow, not the old gaps', () => {
    expect(guide).not.toContain('does not yet invoke this consumer');
    expect(guide).not.toContain('generate Web ZIPs, push container images');
    expect(guide).toMatch(/\| Web +\| `Trinity-Web-<version>\.zip`/);
  });

  it('cover the first publish and a dropped container run', () => {
    expect(guide).toContain('package visibility to **Public**');
    expect(guide).toMatch(/Container run cancelled[^\n]*dispatch/i);
    expect(readme).toContain('ghcr.io/quwisky/trinity-web:latest');
  });
});

describe('container registry token', () => {
  const { jobs } = parse(read('.github/workflows/container.yml'));
  const runs = (job) => job.steps.flatMap((step) => step.run ?? []).join('\n');
  const usesOf = (job) => job.steps.flatMap((step) => step.uses ?? []);

  it('verifies and smoke-tests with a read-only token', () => {
    const { build } = jobs;
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(usesOf(build)).toContain('./.github/actions/setup');
    expect(runs(build)).toContain('pnpm nx run trinity-web-container:smoke');
    expect(JSON.stringify(build)).not.toContain('packages');
    expect(usesOf(build).join('\n')).not.toContain('docker/login-action@');
    expect(runs(build)).not.toContain('--push');
  });

  it('pushes from a job that installs and runs nothing from the repository', () => {
    const { publish } = jobs;
    expect(publish.needs).toBe('build');
    expect(publish.permissions).toEqual({ packages: 'write' });
    for (const uses of usesOf(publish)) {
      expect(uses).not.toMatch(/^\.\/|^actions\/checkout@/);
    }
    expect(runs(publish)).not.toMatch(/\bpnpm\b|\bnx\b|scripts\/|\bnpx\b/);
    expect(runs(publish)).toContain('docker buildx build');
    const login = publish.steps.find((step) =>
      step.uses?.startsWith('docker/login-action@'),
    );
    expect(login.with.password).toBe('${{ github.token }}');
  });

  it('hands the staged context and its tags from build to publish', () => {
    const { build, publish } = jobs;
    const stage = build.steps.find((step) => step.id === 'stage');
    expect(stage.run).toContain(
      'node scripts/web-container.mjs stage dist/web-image-context',
    );
    expect(stage.run).toContain(
      'tar -cf dist/web-image-context.tar -C dist web-image-context',
    );
    const upload = build.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    const download = publish.steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(upload.with.path).toBe('dist/web-image-context.tar');
    expect(download.with).toEqual({ name: upload.with.name, path: 'dist' });
    expect(runs(publish)).toContain(
      'tar -xf dist/web-image-context.tar -C dist',
    );
    for (const output of ['names', 'revision', 'version'])
      expect(build.outputs[output], output).toBeTruthy();
    expect(runs(publish)).toContain('"$REVISION"');
    expect(runs(publish)).not.toContain('git rev-parse');
  });
});

describe('container workflow robustness', () => {
  const container = read('.github/workflows/container.yml');

  it('stops when the tag script fails or yields no tags', () => {
    expect(container).not.toContain('< <(node scripts/web-image-tags.mjs');
    expect(container).toContain(
      'out=$(node scripts/web-image-tags.mjs --tag "$TAG")',
    );
    expect(container).toContain('if [ ${#names[@]} -eq 0 ]; then');
  });

  it('reads every published release, not only the newest 200', () => {
    expect(container).not.toContain('--limit 200');
    expect(container).toContain('gh api --paginate "repos/$GH_REPO/releases"');
  });

  it('tells a missing zip apart from a failed download', () => {
    const listed = container.indexOf(
      'gh release view "$TAG" --json assets -q \'.assets[].name\'',
    );
    const missing = container.indexOf(
      '::error::$TAG has no $ASSET release asset',
    );
    const download = container.indexOf('gh release download');
    expect(listed).toBeGreaterThan(-1);
    expect(listed).toBeLessThan(missing);
    expect(missing).toBeLessThan(download);
    expect(container).toContain('::error::Could not download $ASSET for $TAG');
  });

  it('fails instead of printing an undefined digest, and pushes no provenance platform', () => {
    expect(container).toContain(
      "digest=$(node -e \"const d = require('./dist/web-image-metadata.json')['containerimage.digest']; if (!d) process.exit(1); console.log(d)\")",
    );
    expect(container).not.toContain(
      "node -p \"require('./dist/web-image-metadata.json')",
    );
    expect(container).toContain('--provenance=false');
  });
});

describe('release package timeouts', () => {
  it('gives macOS signing 120 minutes for notarization and the package legs 45', () => {
    const release = read('.github/workflows/release.yml');
    expect(job(release, 'sign-mac')).toContain('timeout-minutes: 120');
    expect(job(release, 'package')).toContain('timeout-minutes: 45');
  });
});

describe('GHCR repository link', () => {
  it('annotates the multi-arch index so GitHub links the package to the repository', () => {
    const container = read('.github/workflows/container.yml');
    // GHCR reads org.opencontainers.image.source from the index annotations for a
    // multi-arch image; per-platform config labels alone leave the package unlinked.
    for (const key of ['source', 'description', 'licenses'])
      expect(container).toContain(
        `--annotation "index:org.opencontainers.image.${key}=`,
      );
  });
});

describe('macOS notarization', () => {
  it("notarizes once, through electron-builder's built-in notarization", () => {
    const config = read('electron/electron-builder.yml');
    // A second afterSign notarization resubmitted the already-notarized app and
    // doubled the wait on Apple's notary queue.
    expect(config).not.toMatch(/^afterSign:/m);
    expect(config).not.toMatch(/^\s+notarize:\s*false/m);
    expect(existsSync(join(root, 'electron/build/notarize.cjs'))).toBe(false);
  });
});
