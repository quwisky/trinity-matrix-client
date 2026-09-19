import assert from 'node:assert/strict';

export const COMPOSER_FORMATTING_SOURCES = {
  helpers:
    'e2e/browser/journeys/conversations/composer-formatting.spec.mts:28-113',
  apply:
    'e2e/browser/journeys/conversations/composer-formatting.spec.mts:584-620',
  preview:
    'e2e/browser/journeys/conversations/composer-formatting.spec.mts:621-657',
  compact:
    'e2e/browser/journeys/conversations/composer-formatting.spec.mts:658-697',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
  navigation: 'e2e/support/journeys/navigation.mts',
} as const;

export const composerFormattingAssertions = {
  applyComposerReady: 'composer-formatting.apply.composer-ready',
  applyTargetWidth: 'composer-formatting.apply.target-width',
  applyTargetHeight: 'composer-formatting.apply.target-height',
  applySheetVisible: 'composer-formatting.apply.sheet-visible',
  applySheetMeasured: 'composer-formatting.apply.sheet-measured',
  applySheetLeftBound: 'composer-formatting.apply.sheet-left-bound',
  applySheetRightBound: 'composer-formatting.apply.sheet-right-bound',
  applySheetTopBound: 'composer-formatting.apply.sheet-top-bound',
  applySheetBottomBound: 'composer-formatting.apply.sheet-bottom-bound',
  applyFormattedValue: 'composer-formatting.apply.formatted-value',
  applySheetHidden: 'composer-formatting.apply.sheet-hidden',
  applyComposerFocused: 'composer-formatting.apply.composer-focused',
  previewComposerReady: 'composer-formatting.preview.composer-ready',
  previewCancelHidden: 'composer-formatting.preview.cancel-hidden',
  previewCancelValue: 'composer-formatting.preview.cancel-value',
  previewCancelSelectionStart:
    'composer-formatting.preview.cancel-selection-start',
  previewCancelSelectionEnd: 'composer-formatting.preview.cancel-selection-end',
  previewBoldContent: 'composer-formatting.preview.bold-content',
  previewHidden: 'composer-formatting.preview.preview-hidden',
  previewComposerFocused: 'composer-formatting.preview.composer-focused',
  previewSelectionStart: 'composer-formatting.preview.selection-start',
  previewSelectionEnd: 'composer-formatting.preview.selection-end',
  previewSendVisible: 'composer-formatting.preview.send-visible',
  compactComposerReady: 'composer-formatting.compact.composer-ready',
  compactComposerVisible: 'composer-formatting.compact.composer-visible',
  compactRootFontSize: 'composer-formatting.compact.root-font-size',
  compactFormatVisible: 'composer-formatting.compact.format-visible',
  compactFormatWidth: 'composer-formatting.compact.format-width',
  compactFormatHeight: 'composer-formatting.compact.format-height',
  compactFormatLeftBound: 'composer-formatting.compact.format-left-bound',
  compactFormatRightBound: 'composer-formatting.compact.format-right-bound',
  compactSendVisible: 'composer-formatting.compact.send-visible',
  compactSendWidth: 'composer-formatting.compact.send-width',
  compactSendHeight: 'composer-formatting.compact.send-height',
  compactSendLeftBound: 'composer-formatting.compact.send-left-bound',
  compactSendRightBound: 'composer-formatting.compact.send-right-bound',
  compactPreviewContent: 'composer-formatting.compact.preview-content',
  compactComposerFocused: 'composer-formatting.compact.composer-focused',
  compactComposerValue: 'composer-formatting.compact.composer-value',
} as const;

export type ComposerFormattingAssertion =
  (typeof composerFormattingAssertions)[keyof typeof composerFormattingAssertions];

export const composerFormattingStageAssertions = {
  apply: [
    composerFormattingAssertions.applyComposerReady,
    composerFormattingAssertions.applyTargetWidth,
    composerFormattingAssertions.applyTargetHeight,
    composerFormattingAssertions.applySheetVisible,
    composerFormattingAssertions.applySheetMeasured,
    composerFormattingAssertions.applySheetLeftBound,
    composerFormattingAssertions.applySheetRightBound,
    composerFormattingAssertions.applySheetTopBound,
    composerFormattingAssertions.applySheetBottomBound,
    composerFormattingAssertions.applyFormattedValue,
    composerFormattingAssertions.applySheetHidden,
    composerFormattingAssertions.applyComposerFocused,
  ],
  preview: [
    composerFormattingAssertions.previewComposerReady,
    composerFormattingAssertions.previewCancelHidden,
    composerFormattingAssertions.previewCancelValue,
    composerFormattingAssertions.previewCancelSelectionStart,
    composerFormattingAssertions.previewCancelSelectionEnd,
    composerFormattingAssertions.previewBoldContent,
    composerFormattingAssertions.previewHidden,
    composerFormattingAssertions.previewComposerFocused,
    composerFormattingAssertions.previewSelectionStart,
    composerFormattingAssertions.previewSelectionEnd,
    composerFormattingAssertions.previewSendVisible,
  ],
  compact: [
    composerFormattingAssertions.compactComposerReady,
    composerFormattingAssertions.compactComposerVisible,
    composerFormattingAssertions.compactRootFontSize,
    composerFormattingAssertions.compactFormatVisible,
    composerFormattingAssertions.compactFormatWidth,
    composerFormattingAssertions.compactFormatHeight,
    composerFormattingAssertions.compactFormatLeftBound,
    composerFormattingAssertions.compactFormatRightBound,
    composerFormattingAssertions.compactSendVisible,
    composerFormattingAssertions.compactSendWidth,
    composerFormattingAssertions.compactSendHeight,
    composerFormattingAssertions.compactSendLeftBound,
    composerFormattingAssertions.compactSendRightBound,
    composerFormattingAssertions.compactPreviewContent,
    composerFormattingAssertions.compactComposerFocused,
    composerFormattingAssertions.compactComposerValue,
  ],
} as const;

const assertionIds = Object.values(composerFormattingAssertions);

export const COMPOSER_FORMATTING_ASSERTION_RECORDS = assertionIds.length;

assert.equal(composerFormattingStageAssertions.apply.length, 12);
assert.equal(composerFormattingStageAssertions.preview.length, 11);
assert.equal(composerFormattingStageAssertions.compact.length, 16);
assert.equal(assertionIds.length, 39);
assert.equal(new Set(assertionIds).size, 39);
