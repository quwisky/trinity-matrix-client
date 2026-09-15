import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(
  root,
  'e2e/browser/journeys/room-administration/space-settings-mobile.spec.mts',
);
const replacementPath = resolve(
  root,
  'e2e/android/space-settings-mobile-journeys.mts',
);
const assertionIds = [
  'opening.composer-visible',
  'settings.visible',
  'settings.full-width',
  'settings.full-height',
  'directory.visible',
  'general.initially-hidden',
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
  'directory.space-name-contained',
  'general-tab.touch-target',
  'for-you-tab.touch-target',
  'for-you.panel-visible',
  'for-you.heading-focused',
  'for-you.alphabetical-touch-target',
  'for-you.alphabetical-retained',
  'for-you.back-directory-visible',
  'access-tab.touch-target',
  'access.panel-visible',
  'access.heading-focused',
  'access.explainer-visible',
  'access.actions-hidden',
  'access.back-directory-visible',
  'contents-tab.touch-target',
  'contents.heading-focused',
  'contents.room-visible',
  'contents.create-room-touch-target',
  'contents.create-room-contained',
  'contents.suggested-touch-target',
  'contents.suggested-checked',
  'contents.move-up-touch-target',
  'contents.move-up-disabled',
  'contents.move-down-disabled',
  'contents.suggested-cleared',
  'contents.candidate-pick-visible',
  'contents.add-selected-enabled',
  'contents.candidate-visible',
  'contents.candidate-link-created',
  'contents.create-cancelled',
  'contents.remove-cancel-retained',
  'contents.candidate-link-removed',
  'contents.candidate-membership-retained',
  'contents.back-directory-visible',
  'general.reopened-visible',
  'settings.closed',
  'space-pill.visible',
  'room.composer-visible',
  'room.heading-named',
  'members.panel-visible',
  'members.directory-hidden',
  'members.heading-named',
  'members.back-visible',
  'members.directory-tab-visible',
  'members.directory-tab-focused',
  'readonly.name-visible',
  'readonly.topic-visible',
  'readonly.name-paragraph',
  'readonly.topic-paragraph',
  'readonly.actions-hidden',
  'readonly.surface-visible',
];

const replacement = () =>
  existsSync(replacementPath) ? readFileSync(replacementPath, 'utf8') : '';

describe('Android mobile Space Settings migration', () => {
  it('pins the unchanged three-definition predecessor', () => {
    const source = readFileSync(sourcePath);
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'fd8dcdd0305cdc1ffa2412cf61779c7775cfe7583563be801ba5be5342fdaaf4',
    );
    for (const title of [
      'opens the directory before General and protects drafts on the full-screen flow',
      'opens the Members shortcut directly and returns to the directory',
      'keeps a member’s Space General readable without writable controls',
    ]) {
      expect(source.toString('utf8')).toContain(`test('${title}'`);
    }
  });

  it('maps exactly three stages and all sixty-seven direct assertions', () => {
    const text = replacement();
    for (const span of [
      'space-settings-mobile.spec.mts:105-433',
      'space-settings-mobile.spec.mts:435-471',
      'space-settings-mobile.spec.mts:473-536',
    ]) {
      expect(text).toContain(span);
    }
    expect(text).toMatch(/assert\.equal\(\s*cases\.length,\s*3,/);
    expect(new Set(assertionIds).size).toBe(67);
    for (const assertion of assertionIds)
      expect(text).toContain(`'${assertion}'`);
  });

  it('keeps product actions native and observations read-only', () => {
    const text = replacement();
    expect(text).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(text).toContain('webview.openSession()');
    expect(text).toContain('client.tapCurrent(');
    expect(text).toContain('client.fill(');
    expect(text).toContain('client.scrollIntoViewIfNeeded(');
    expect(text).toContain(
      `client.fill('[data-testid="space-contents-search"]', candidate.name)`,
    );
    expect(text).toContain(
      `assertions.contentsCreateCancelled, '[data-testid="alert-surface"]', absent`,
    );
    expect(text).toContain('fixtures.setSpaceChild(');
    expect(text).toContain('fixtures.spaceChild(');
    expect(text).toContain('fixtures.roomMembership(');
  });

  it('keeps WebView expressions observational', () => {
    const text = replacement();
    for (const mutation of [
      /\.click\s*\(/,
      /\.focus\s*\(/,
      /\.dispatchEvent\s*\(/,
      /(?:document|window)\.location\s*=/,
      /history\.(?:back|forward|go|pushState|replaceState)\s*\(/,
      /window\.open\s*\(/,
    ])
      expect(text).not.toMatch(mutation);
  });
});
