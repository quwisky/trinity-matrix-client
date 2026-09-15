import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-administration/space-settings-resilience.spec.mts',
);
const replacementPath = resolve(
  root,
  'e2e/android/space-settings-resilience-journeys.mts',
);
const clientPath = resolve(root, 'e2e/android/account-workspace-client.mts');
const transitionPath = resolve(
  root,
  'e2e/android/space-settings-account-transition.mts',
);
const focusedFillPath = resolve(
  root,
  'e2e/android/flows/accounts-focused-fill.yaml',
);

const assertionIds = [
  'partial.failure-feedback',
  'partial.name-first-attempts',
  'partial.topic-first-attempts',
  'partial.retry-feedback',
  'partial.name-total-attempts',
  'partial.topic-total-attempts',
  'continuity.opening-account',
  'continuity.name-saving',
  'continuity.active-member',
  'continuity.account-retained',
  'continuity.name-saved',
  'continuity.topic-saved',
  'continuity.topic-persisted',
  'continuity.alias-visible',
  'continuity.alias-resolves',
  'continuity.invite-persisted',
  'continuity.child-link-created',
  'continuity.child-link-removed',
];

const replacement = () =>
  existsSync(replacementPath) ? readFileSync(replacementPath, 'utf8') : '';
const transition = () =>
  existsSync(transitionPath) ? readFileSync(transitionPath, 'utf8') : '';

describe('Android Space Settings resilience migration', () => {
  it('pins both unchanged functional predecessor definitions', () => {
    const source = readFileSync(sourcePath);
    const text = source.toString('utf8');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '97bf56cb47ac1f74911fa73df01d582f1cec4c37f8547e4d609f168fbb9a3091',
    );
    for (const title of [
      'retains a partial General failure and retries only the unsaved field',
      'keeps late and subsequent writes on the opening Account after an Account switch',
    ]) {
      expect(text).toContain(`test('${title}'`);
    }
  });

  it('maps exactly two stages and all eighteen direct assertions', () => {
    const text = replacement();
    for (const span of [
      'space-settings-resilience.spec.mts:69-143',
      'space-settings-resilience.spec.mts:69-82,145-305',
    ]) {
      expect(text).toContain(span);
    }
    expect(text).toMatch(
      /assert\.equal\(\s*cases\.length,\s*2,\s*'Exactly two Space Settings resilience stages are required'/,
    );
    expect(new Set(assertionIds).size).toBe(18);
    for (const assertion of assertionIds) {
      expect(text).toContain(`'${assertion}'`);
    }
  });

  it('keeps product actions native except for the pinned Account transition', () => {
    const text = replacement();
    expect(text).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(text).toContain('webview.openSession()');
    expect(text).toContain('installFirstMatrixHttpFailure(');
    expect(text).toContain('installMatrixRoomStateDelay(');
    expect(text).toContain('switchBlockedSpaceSettingsAccount(');
    expect(text).toContain('client.tapCurrent(');
    expect(text).toContain('client.fill(');
    expect(text).toContain('client.replace(');
    expect(text).toContain("'PartialSpaceRenamed'");
    expect(text).toContain("'OpeningAccountSpaceRenamed'");
    expect(text).toContain('fixtures.roomState(');
    expect(text).toContain('fixtures.resolveRoomAlias(');
    expect(text).toContain('fixtures.roomMembership(');
    expect(text).toContain('fixtures.spaceChild(');
    expect(
      text.match(
        /AbortSignal\.any\(\[signal, AbortSignal\.timeout\(30_000\)\]\)/g,
      ),
    ).toHaveLength(3);
    const focusedFill = readFileSync(focusedFillPath, 'utf8');
    expect(focusedFill.match(/^- eraseText$/gm)).toHaveLength(2);
  });

  it('confines the source-required CDP exception to exact menu and Account-row clicks', () => {
    const text = transition();
    expect(text).toContain('space-settings-resilience.spec.mts:199-205');
    expect(text).toContain('[data-testid="user-menu-trigger"]');
    expect(text).toContain('[data-testid="account-row"]');
    expect(text.match(/\.click\(\)/g)).toHaveLength(2);
    expect(text).toContain('active Account changed');
    expect(text).toContain('client.record(');
    for (const mutation of [
      /\.focus\s*\(/,
      /\.dispatchEvent\s*\(/,
      /(?:document|window)\.location\s*=/,
      /history\.(?:back|forward|go|pushState|replaceState)\s*\(/,
      /window\.open\s*\(/,
    ]) {
      expect(text).not.toMatch(mutation);
    }
  });

  it('accepts exact focused native input without requiring a duplicate click event', () => {
    const client = readFileSync(clientPath, 'utf8');
    expect(client).toContain('target.length === 1 && target[0]!.focused');
    expect(client).toContain('allowFocusedInput: true');
    expect(client).toMatch(/this\.nativeAction\(\s*'accounts-point-fill'/);
    expect(client).toContain('Native input reached ${selector}');
  });
});
