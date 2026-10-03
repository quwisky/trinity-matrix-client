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
