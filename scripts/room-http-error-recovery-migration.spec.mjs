import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-library/room-http-error-recovery.spec.mts',
);
const replacementPath = resolve(
  root,
  'e2e/android/room-http-error-recovery-journeys.mts',
);

const assertionIds = [
  'invite.failure-feedback',
  'invite.action-reenabled',
  'invite.success-feedback',
  'invite.two-transport-attempts',
  'invite.real-membership',
  'join.invite-visible',
  'join.failure-feedback',
  'join.action-reenabled',
  'join.room-visible',
  'join.two-transport-attempts',
  'join.real-membership',
];

function replacement() {
  return existsSync(replacementPath)
    ? readFileSync(replacementPath, 'utf8')
    : '';
}

describe('Android room HTTP-error recovery migration', () => {
  it('pins both unchanged functional predecessor definitions', () => {
    const source = readFileSync(sourcePath);
    const text = source.toString('utf8');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'a9fd9a2f48a03061ceed67a94a2e81104472144683e65650099dba6074042fe6',
    );
    for (const title of [
      'retries an outbound room invite after an HTTP failure',
      'retries accepting a room invite after an HTTP failure',
    ]) {
      expect(text).toContain(`test('${title}'`);
    }
  });

  it('maps exactly two stages and all eleven direct assertions', () => {
    const text = replacement();

    for (const span of ['73-127', '129-192']) {
      expect(text).toContain(
        `e2e/browser/journeys/room-library/room-http-error-recovery.spec.mts:${span}`,
      );
    }
    expect(text).toMatch(
      /assert\.equal\(\s*cases\.length,\s*2,\s*'Exactly two room HTTP-error recovery stages are required'/,
    );
    expect(new Set(assertionIds).size).toBe(11);
    for (const assertion of assertionIds) {
      expect(text).toContain(`'${assertion}'`);
    }
  });

  it('keeps faulting at transport and every product action in Maestro', () => {
    const text = replacement();

    expect(text).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(text).toContain('webview.openSession()');
    expect(text).toContain('installFirstMatrixHttpFailure(');
    expect(text).toContain("withTransportFault(context, 'invite', 503");
    expect(text).toContain("withTransportFault(context, 'join', 502");
    expect(text).toContain('client.tapCurrent(');
    expect(text).toContain('client.fill(');
    expect(text).toContain('fixtures.roomMembership(');
    expect(text).toContain('firstOutcome: fault?.firstOutcome');
    expect(text).toContain('new MutationObserver(sample)');
    expect(text).toContain('observer.disconnect()');
    expect(text).toContain('exactFeedbackDuringNativeAction(');
    expect(text).toContain("document.querySelectorAll('[data-sonner-toast]')");
  });

  it('keeps WebView expressions observational', () => {
    const text = replacement();

    for (const mutation of [
      /\.click\s*\(/,
      /\.focus\s*\(/,
      /\.dispatchEvent\s*\(/,
      /(?:document|window)\.location\s*=/,
      /(?:document|window)\.location\.(?:assign|replace)\s*\(/,
      /history\.(?:back|forward|go|pushState|replaceState)\s*\(/,
      /window\.open\s*\(/,
    ]) {
      expect(text).not.toMatch(mutation);
    }
  });
});
