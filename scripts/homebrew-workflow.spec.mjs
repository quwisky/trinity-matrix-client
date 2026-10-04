/** The tap only ever receives a published, signed release, written by the deploy key. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(
  resolve(root, '.github/workflows/homebrew.yml'),
  'utf8',
);
const workflow = parse(source);
const job = workflow.jobs.tap;
const stepIndex = (name) => job.steps.findIndex((step) => step.name === name);

describe('Homebrew tap workflow', () => {
  it('runs on publish or a repair dispatch, serialized, read-only on this repo', () => {
    expect(workflow.on.release.types).toEqual(['published']);
    expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(workflow.concurrency).toEqual({
      group: 'homebrew',
      'cancel-in-progress': false,
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job['runs-on']).toBe('macos-latest');
  });

  it('gates on signing before generating or pushing anything', () => {
    const gate = stepIndex('App is signed, notarized and stapled');
    const write = stepIndex('Write, check and push the cask');
    expect(gate).toBeGreaterThan(stepIndex('Download the macOS zip'));
    expect(write).toBeGreaterThan(gate);
    const run = job.steps[gate].run;
    expect(run).toContain('codesign --verify --deep --strict');
    expect(run).toContain('spctl --assess --type execute');
    expect(run).toContain('xcrun stapler validate');
  });

  it('uses the deploy key only to check out the tap', () => {
    expect(source.match(/HOMEBREW_TAP_DEPLOY_KEY/g)).toHaveLength(1);
    const tap = job.steps.find(
      (step) => step.with?.repository === 'quwisky/homebrew-trinity',
    );
    expect(tap.with['ssh-key']).toBe('${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}');
    expect(tap.with.path).toBe('tap');
  });

  it('finishes without a commit when the cask is unchanged', () => {
    const run = job.steps[stepIndex('Write, check and push the cask')].run;
    expect(run.indexOf('status --porcelain')).toBeLessThan(
      run.indexOf('git -C tap commit'),
    );
    expect(run.indexOf('brew audit')).toBeLessThan(
      run.indexOf('git -C tap push'),
    );
  });

  it('holds the deploy key in a protected environment and authenticates brew', () => {
    expect(job.environment).toBe('homebrew');
    expect(job.env.HOMEBREW_GITHUB_API_TOKEN).toBe('${{ github.token }}');
  });

  it('allowlists trinity@next for the GitHub prerelease audit only while the tap has it', () => {
    const run = job.steps[stepIndex('Write, check and push the cask')].run;
    expect(run).toContain('audit_exceptions/github_prerelease_allowlist.json');
    expect(run).toContain('{ "trinity@next": "all" }');
    // brew audit rejects an allowlist naming a cask the tap does not contain, which broke
    // the first stable release before any prerelease cask existed.
    expect(run).toMatch(
      /if \[ -f tap\/Casks\/trinity@next\.rb \]; then\n\s+echo '\{ "trinity@next": "all" \}' > tap\/audit_exceptions\/github_prerelease_allowlist\.json\n\s*else\n\s+rm -f tap\/audit_exceptions\/github_prerelease_allowlist\.json\n\s*fi/,
    );
    expect(run.indexOf('github_prerelease_allowlist')).toBeLessThan(
      run.indexOf('brew audit --cask'),
    );
  });

  it('requires the app minimum macOS to match the cask before writing', () => {
    const run =
      job.steps[stepIndex('App is signed, notarized and stapled')].run;
    expect(run).toContain('LSMinimumSystemVersion');
    expect(run).toContain('13.0');
  });

  it('pins every action by commit SHA', () => {
    for (const step of job.steps.filter((s) => s.uses)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('picks the cask and rejects malformed tags in the resolve step', () => {
    const run = job.steps[stepIndex('Resolve the release')].run;
    const resolveTag = (TAG) => {
      const dir = mkdtempSync(join(tmpdir(), 'homebrew-resolve-'));
      const out = join(dir, 'output');
      const result = spawnSync('bash', ['-e', '-c', run], {
        env: { PATH: process.env.PATH, TAG, GITHUB_OUTPUT: out },
      });
      const text = result.status === 0 ? readFileSync(out, 'utf8') : '';
      rmSync(dir, { recursive: true, force: true });
      return { status: result.status, text };
    };
    expect(resolveTag('v0.2.0').text).toContain('cask=trinity\n');
    expect(resolveTag('v0.2.0-next.1').text).toContain('cask=trinity@next\n');
    expect(resolveTag('v0.2.0').text).toContain(
      'asset=Trinity-0.2.0-arm64-mac.zip\n',
    );
    expect(resolveTag('v0.2.0-beta.1').status).not.toBe(0);
    expect(resolveTag('0.2.0').status).not.toBe(0);
  });

  it('writes the stable cask only for the latest release, before touching the tap', () => {
    const check = stepIndex('Stable cask follows the latest release');
    expect(check).toBeGreaterThan(stepIndex('Resolve the release'));
    const step = job.steps[check];
    expect(step.run).toContain('[ "$CASK" = trinity ] || exit 0');
    expect(step.run).toContain(
      'latest=$(gh api "repos/$GH_REPO/releases/latest" -q .tag_name)',
    );
    expect(step.run).toContain('if [ "$latest" != "$TAG" ]');
    expect(step.run).toContain('::notice::');
    expect(step.run).toContain('echo "skip=true" >> "$GITHUB_OUTPUT"');
    const tap = job.steps.findIndex(
      (s) => s.with?.repository === 'quwisky/homebrew-trinity',
    );
    for (const later of job.steps.slice(check + 1)) {
      expect(later.if, later.name ?? later.uses).toBe(
        "${{ steps.latest.outputs.skip != 'true' }}",
      );
    }
    expect(check).toBeLessThan(tap);
    expect(step.id).toBe('latest');
  });

  it('refuses drafts before downloading', () => {
    const check = stepIndex('Release is published');
    expect(check).toBeGreaterThan(stepIndex('Resolve the release'));
    expect(check).toBeLessThan(stepIndex('Download the macOS zip'));
    expect(job.steps[check].run).toContain('--json isDraft');
  });
});
