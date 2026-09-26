import assert from 'node:assert/strict';

export const COMPOSER_TYPING_SOURCES = {
  helpers: 'e2e/browser/journeys/conversations/composer-typing.spec.mts:22-122',
  showClear: 'e2e/browser/journeys/conversations/composer-typing.spec.mts:127-153',
  reservedSlot: 'e2e/browser/journeys/conversations/composer-typing.spec.mts:157-197',
  longName: 'e2e/browser/journeys/conversations/composer-typing.spec.mts:204-249',
  liveAnimation: 'e2e/browser/journeys/conversations/composer-typing.spec.mts:251-283',
  reducedMotion: 'e2e/browser/journeys/conversations/composer-typing.spec.mts:285-319',
  sidebarProjection: 'e2e/browser/journeys/conversations/composer-typing.spec.mts:321-356',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const composerTypingAssertions = {
  showClearComposerReady: 'composer-typing.show-clear.composer-ready',
  showClearIndicatorVisible: 'composer-typing.show-clear.indicator-visible',
  showClearExactCopy: 'composer-typing.show-clear.exact-copy',
  showClearHiddenAfterStop: 'composer-typing.show-clear.hidden-after-stop',
  reservedSlotComposerReady: 'composer-typing.reserved-slot.composer-ready',
  reservedSlotIdleHeightPositive: 'composer-typing.reserved-slot.idle-height-positive',
  reservedSlotIndicatorVisible: 'composer-typing.reserved-slot.indicator-visible',
  reservedSlotHeightStable: 'composer-typing.reserved-slot.height-stable',
  longNameComposerReady: 'composer-typing.long-name.composer-ready',
  longNameIdleHeightPositive: 'composer-typing.long-name.idle-height-positive',
  longNameIndicatorVisible: 'composer-typing.long-name.indicator-visible',
  longNameHeightStable: 'composer-typing.long-name.height-stable',
  longNameTextOverflows: 'composer-typing.long-name.text-overflows',
  liveAnimationComposerReady: 'composer-typing.live-animation.composer-ready',
  liveAnimationIndicatorVisible: 'composer-typing.live-animation.indicator-visible',
  liveAnimationOneAnimation: 'composer-typing.live-animation.one-animation',
  liveAnimationDuration1000ms: 'composer-typing.live-animation.duration-1000ms',
  liveAnimationInfiniteIterations: 'composer-typing.live-animation.infinite-iterations',
  reducedMotionComposerReady: 'composer-typing.reduced-motion.composer-ready',
  reducedMotionIndicatorVisible: 'composer-typing.reduced-motion.indicator-visible',
  reducedMotionFullOpacityDots: 'composer-typing.reduced-motion.full-opacity-dots',
  sidebarProjectionComposerReady: 'composer-typing.sidebar-projection.composer-ready',
  sidebarProjectionExactCopy: 'composer-typing.sidebar-projection.exact-copy',
  sidebarProjectionClears: 'composer-typing.sidebar-projection.clears',
  sidebarProjectionLocalKeepsExactCopy: 'composer-typing.sidebar-projection.local-keeps-exact-copy',
} as const;

export type ComposerTypingAssertion =
  (typeof composerTypingAssertions)[keyof typeof composerTypingAssertions];

export const composerTypingStageAssertions = {
  showClear: [
    composerTypingAssertions.showClearComposerReady,
    composerTypingAssertions.showClearIndicatorVisible,
    composerTypingAssertions.showClearExactCopy,
    composerTypingAssertions.showClearHiddenAfterStop,
  ],
  reservedSlot: [
    composerTypingAssertions.reservedSlotComposerReady,
    composerTypingAssertions.reservedSlotIdleHeightPositive,
    composerTypingAssertions.reservedSlotIndicatorVisible,
    composerTypingAssertions.reservedSlotHeightStable,
  ],
  longName: [
    composerTypingAssertions.longNameComposerReady,
    composerTypingAssertions.longNameIdleHeightPositive,
    composerTypingAssertions.longNameIndicatorVisible,
    composerTypingAssertions.longNameHeightStable,
    composerTypingAssertions.longNameTextOverflows,
  ],
  liveAnimation: [
    composerTypingAssertions.liveAnimationComposerReady,
    composerTypingAssertions.liveAnimationIndicatorVisible,
    composerTypingAssertions.liveAnimationOneAnimation,
    composerTypingAssertions.liveAnimationDuration1000ms,
    composerTypingAssertions.liveAnimationInfiniteIterations,
  ],
  reducedMotion: [
    composerTypingAssertions.reducedMotionComposerReady,
    composerTypingAssertions.reducedMotionIndicatorVisible,
    composerTypingAssertions.reducedMotionFullOpacityDots,
  ],
  sidebarProjection: [
    composerTypingAssertions.sidebarProjectionComposerReady,
    composerTypingAssertions.sidebarProjectionExactCopy,
    composerTypingAssertions.sidebarProjectionClears,
    composerTypingAssertions.sidebarProjectionLocalKeepsExactCopy,
  ],
} as const;

const assertionIds = Object.values(composerTypingAssertions);

export const COMPOSER_TYPING_ASSERTION_RECORDS = assertionIds.length;

assert.equal(composerTypingStageAssertions.showClear.length, 4);
assert.equal(composerTypingStageAssertions.reservedSlot.length, 4);
assert.equal(composerTypingStageAssertions.longName.length, 5);
assert.equal(composerTypingStageAssertions.liveAnimation.length, 5);
assert.equal(composerTypingStageAssertions.reducedMotion.length, 3);
assert.equal(composerTypingStageAssertions.sidebarProjection.length, 4);
assert.equal(assertionIds.length, 25);
assert.equal(new Set(assertionIds).size, 25);
