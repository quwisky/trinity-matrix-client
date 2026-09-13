import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const forYouSourcePath = resolve(
  root,
  'e2e/browser/journeys/room-administration/room-settings-for-you-mobile.spec.mts',
);
const generalSourcePath = resolve(
  root,
  'e2e/browser/journeys/room-administration/room-settings-general-mobile.spec.mts',
);
const replacementPath = resolve(
  root,
  'e2e/android/room-settings-mobile-journeys.mts',
);

const assertionIds = [
  'for-you.settings-visible',
  'for-you.directory-visible',
  'for-you.form-visible',
  'for-you.mute-enabled',
  'for-you.favourite-enabled',
  'for-you.mute-retained',
  'for-you.favourite-retained',
  'for-you.saved-feedback',
  'general.settings-visible',
  'general.full-width',
  'general.full-height',
  'general.directory-visible',
  'general.panel-initially-hidden',
  'general.panel-visible',
  'general.heading-focused',
  'general.account-contained',
  'general.pristine-actions-hidden',
  'general.draft-actions-visible',
  'general.actions-sticky',
  'general.discard-visible',
  'general.save-visible',
  'general.draft-retained',
  'general.discard-directory-visible',
  'general.room-name-contained',
  'general-tab.touch-target',
  'addresses-tab.touch-target',
  'access.panel-visible',
  'access.heading-focused',
  'access.actions-hidden',
  'access.back-directory-visible',
  'general.reopened-visible',
  'general.settings-closed',
  'general.composer-visible',
];

function replacement() {
  return existsSync(replacementPath)
    ? readFileSync(replacementPath, 'utf8')
    : '';
}

describe('Android mobile Room Settings migration', () => {
  it('pins both unchanged functional predecessor definitions', () => {
    const predecessors = [
      {
        path: forYouSourcePath,
        hash: '749dc05f43e01cfcc972bf639b8f83241ed3054220a32d8f32eb5be197cf62c0',
        title:
          'lets an ordinary member stage, protect, and save personal preferences',
      },
      {
        path: generalSourcePath,
        hash: 'aec529aaa1769eddfa28f9f423d93825bb46ebd689e448036b1c168b5db3c310',
        title:
          'opens the directory before General and protects drafts on the full-screen flow',
      },
    ];

    for (const predecessor of predecessors) {
      const source = readFileSync(predecessor.path);
      expect(createHash('sha256').update(source).digest('hex')).toBe(
        predecessor.hash,
      );
      expect(source.toString('utf8')).toContain(`test('${predecessor.title}'`);
    }
  });

  it('maps exactly two stages and all thirty-three direct assertions', () => {
    const text = replacement();

    for (const source of [
      'e2e/browser/journeys/room-administration/room-settings-for-you-mobile.spec.mts:18-115',
      'e2e/browser/journeys/room-administration/room-settings-general-mobile.spec.mts:18-149',
    ]) {
      expect(text).toContain(source);
    }
    expect(text).toMatch(
      /assert\.equal\(\s*cases\.length,\s*2,\s*'Exactly two mobile Room Settings stages are required'/,
    );
    expect(new Set(assertionIds).size).toBe(33);
    for (const assertion of assertionIds) {
      expect(text).toContain(`'${assertion}'`);
    }
  });

  it('keeps every product action in Maestro and observations in the WebView', () => {
    const text = replacement();

    expect(text).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(text).toContain('webview.openSession()');
    expect(text).toContain('client.tapCurrent(');
    expect(text).toContain('client.fill(');
    expect(text).toContain(
      'client.tapCurrent(\'[data-testid="room-settings-mobile-back"]\')',
    );
    expect(text).toContain('client.scrollIntoViewIfNeeded(');
    expect(text).toContain('fixtures.roomMembership(');
    expect(text).toContain(
      'Notifications and favourite saved for the opening Account.',
    );
    expect(text).toContain("getComputedStyle(element).position === 'sticky'");
    expect(text).toContain('window.visualViewport');
    expect(text).toContain(
      "document.activeElement?.getAttribute('data-testid')",
    );
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
