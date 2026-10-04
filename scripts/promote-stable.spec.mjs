/** The promote summary predicts the stable version the way release-please does (bump-minor-pre-major). */
import {
  expectedBump,
  lastStableTag,
  nextVersion,
  parseCommit,
  summary,
} from './promote-stable.mjs';

const c = (subject, body = '') => parseCommit(subject, body);

describe('expectedBump', () => {
  it('is a patch bump for fixes only', () => {
    expect(expectedBump([c('fix(a): x'), c('perf: y')], '0.1.0')).toBe('patch');
  });

  it('is a minor bump when any commit is a feat', () => {
    expect(expectedBump([c('fix: x'), c('feat(a): y')], '0.1.0')).toBe('minor');
  });

  it('is a minor bump for a breaking change before 1.0', () => {
    expect(expectedBump([c('fix!: x')], '0.1.0')).toBe('minor');
    expect(expectedBump([c('fix: x', 'BREAKING CHANGE: y')], '0.1.0')).toBe(
      'minor',
    );
  });

  it('is a major bump for a breaking change from 1.0', () => {
    expect(expectedBump([c('feat!: x')], '1.2.0')).toBe('major');
  });

  it('is null when nothing releasable landed', () => {
    expect(expectedBump([c('chore: x'), c('docs: y')], '0.1.0')).toBeNull();
  });
});

describe('nextVersion', () => {
  it.each([
    ['0.1.0', 'patch', '0.1.1'],
    ['0.1.1', 'minor', '0.2.0'],
    ['1.2.3', 'major', '2.0.0'],
  ])('%s + %s = %s', (v, bump, out) => {
    expect(nextVersion(v, bump)).toBe(out);
  });
});

describe('lastStableTag', () => {
  it('skips prereleases and picks the highest version', () => {
    expect(
      lastStableTag(['v0.1.0', 'v0.2.0-next.1', 'v0.10.0', 'v0.9.0', 'x']),
    ).toBe('v0.10.0');
  });
});

describe('summary', () => {
  it('lists releasable subjects, breaking markers and the expected release', () => {
    const text = summary('v0.1.0', [
      c('feat(a): add x'),
      c('fix!: drop y'),
      c('chore: noise'),
    ]);
    expect(text).toContain('v0.1.0');
    expect(text).toContain('feat(a): add x');
    expect(text).toContain('fix!: drop y');
    expect(text).not.toContain('chore: noise');
    expect(text).toContain('Breaking');
    expect(text).toContain('v0.2.0');
  });
});
