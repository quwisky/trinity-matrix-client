import assert from 'node:assert/strict';

export const ROOM_WIDGET_SOURCES = {
  mobile:
    'e2e/browser/journeys/room-administration/room-settings-widgets-mobile.spec.mts:37-236',
  bridge:
    'e2e/browser/journeys/room-administration/room-widget-settings.spec.mts:20-235',
  management:
    'e2e/browser/journeys/room-administration/room-widget-settings.spec.mts:237-421',
  authority:
    'e2e/browser/journeys/room-administration/room-widget-settings.spec.mts:423-543',
  widgetFixture: 'e2e/browser/support/widget.mts',
  roomSettings: 'e2e/browser/support/room-settings-journey.mts',
  multiAccount: 'e2e/browser/support/multi-account-journey.mts',
  app: 'e2e/support/app.mts',
} as const;

export const roomWidgetInheritedAssertions = {
  mobileWidgetsTabVisible: 'mobile.widgets-tab-visible',
  bridgeRoomTimelineVisible: 'bridge.room-timeline-visible',
  bridgeWidgetsTabVisible: 'bridge.widgets-tab-visible',
  managementRoomTimelineVisible: 'management.room-timeline-visible',
  managementWidgetsTabVisible: 'management.widgets-tab-visible',
  authorityRoomTimelineVisible: 'authority.room-timeline-visible',
  authorityWidgetsTabVisible: 'authority.widgets-tab-visible',
} as const;

export const roomWidgetDirectAssertions = {
  mobileRoomTimelineVisible: 'mobile.room-timeline-visible',
  mobileDiscardCopy: 'mobile.discard-copy',
  mobileDraftNameRetained: 'mobile.draft-name-retained',
  mobileDraftUrlRetained: 'mobile.draft-url-retained',
  mobileCreatedWidgetVisible: 'mobile.created-widget-visible',
  mobileNoEagerRequestAfterCreate: 'mobile.no-eager-request-after-create',
  mobileScrollRegionOverflows: 'mobile.scroll-region-overflows',
  mobileSeededCardCount: 'mobile.seeded-card-count',
  mobileSeededCardLabels: 'mobile.seeded-card-labels',
  mobileLastCardVisible: 'mobile.last-card-visible',
  mobileLongUrlVisible: 'mobile.long-url-visible',
  mobileHorizontalContainment: 'mobile.horizontal-containment',
  mobileNoEagerRequestBeforeEmbed: 'mobile.no-eager-request-before-embed',
  mobileWidgetApiReady: 'mobile.widget-api-ready',
  mobileFrameBoxPresent: 'mobile.frame-box-present',
  mobileFrameWidth: 'mobile.frame-width',
  mobileFrameTopContained: 'mobile.frame-top-contained',
  mobileFrameBottomContained: 'mobile.frame-bottom-contained',
  mobileFrameClosed: 'mobile.frame-closed',
  mobileCancelBoxPresent: 'mobile.cancel-box-present',
  mobileCancelBottomContained: 'mobile.cancel-bottom-contained',
  mobileThemeCancelVisible: 'mobile.theme-cancel-visible',
  mobileThemeOpenVisible: 'mobile.theme-open-visible',
  mobileScaledLastCardVisible: 'mobile.scaled-last-card-visible',

  bridgeCardName: 'bridge.card-name',
  bridgeCardType: 'bridge.card-type',
  bridgeCardRawUrl: 'bridge.card-raw-url',
  bridgeCardOrigin: 'bridge.card-origin',
  bridgeCardRoomSubstitution: 'bridge.card-room-substitution',
  bridgeCardUserSubstitution: 'bridge.card-user-substitution',
  bridgeOpenHref: 'bridge.open-href',
  bridgeOpenTarget: 'bridge.open-target',
  bridgeOpenRel: 'bridge.open-rel',
  bridgeNoEagerRequest: 'bridge.no-eager-request',
  bridgeFirstNegotiating: 'bridge.first-negotiating',
  bridgeFirstCloseFocused: 'bridge.first-close-focused',
  bridgeFirstRequestCount: 'bridge.first-request-count',
  bridgeFirstRequestPresent: 'bridge.first-request-present',
  bridgeSiblingForgeryRejected: 'bridge.sibling-forgery-rejected',
  bridgeFirstFrameClosed: 'bridge.first-frame-closed',
  bridgeEmbedRefocusedAfterFirstClose:
    'bridge.embed-refocused-after-first-close',
  bridgeSecondNegotiating: 'bridge.second-negotiating',
  bridgeSecondRequestPresent: 'bridge.second-request-present',
  bridgeChangedOriginRejected: 'bridge.changed-origin-rejected',
  bridgeEmbedRefocusedAfterSecondClose:
    'bridge.embed-refocused-after-second-close',
  bridgeReady: 'bridge.ready',
  bridgeRequestCount: 'bridge.request-count',
  bridgeReferrers: 'bridge.referrers',
  bridgeSandbox: 'bridge.sandbox',
  bridgeReferrerPolicy: 'bridge.referrer-policy',
  bridgeFullscreenDenied: 'bridge.fullscreen-denied',
  bridgeFixtureHeading: 'bridge.fixture-heading',
  bridgeRequestedCapabilities: 'bridge.requested-capabilities',
  bridgeApprovedCapabilities: 'bridge.approved-capabilities',
  bridgePolicyApi: 'bridge.policy-api',
  bridgeDeniedFeatures: 'bridge.denied-features',
  bridgeMixedContentBlocked: 'bridge.mixed-content-blocked',
  bridgeEmbedRefocusedAfterFinalClose:
    'bridge.embed-refocused-after-final-close',

  managementOpeningAccount: 'management.opening-account',
  managementMemberAccountActive: 'management.member-account-active',
  managementOpeningAccountRetained: 'management.opening-account-retained',
  managementAddingPending: 'management.adding-pending',
  managementCreateError: 'management.create-error',
  managementDraftNameRetained: 'management.draft-name-retained',
  managementDraftUrlRetained: 'management.draft-url-retained',
  managementCardVisible: 'management.card-visible',
  managementCreatorHref: 'management.creator-href',
  managementNoEagerRequestAfterCreate:
    'management.no-eager-request-after-create',
  managementDeclarationPresent: 'management.declaration-present',
  managementDeclarationExact: 'management.declaration-exact',
  managementFeedbackVisible: 'management.feedback-visible',
  managementNameFocused: 'management.name-focused',
  managementConfirmationName: 'management.confirmation-name',
  managementConfirmationScope: 'management.confirmation-scope',
  managementCardRemoved: 'management.card-removed',
  managementNameRefocused: 'management.name-refocused',
  managementNoEagerRequestAfterRemoval:
    'management.no-eager-request-after-removal',
  managementTombstoneEmpty: 'management.tombstone-empty',

  authorityInitialCardVisible: 'authority.initial-card-visible',
  authorityInitialCreateAbsent: 'authority.initial-create-absent',
  authorityInitialRemoveAbsent: 'authority.initial-remove-absent',
  authorityGrantedCreateVisible: 'authority.granted-create-visible',
  authorityGrantedRemoveVisible: 'authority.granted-remove-visible',
  authorityRevokedCreateAbsent: 'authority.revoked-create-absent',
  authorityRevokedRemoveAbsent: 'authority.revoked-remove-absent',
  authorityNoEagerRequest: 'authority.no-eager-request',
} as const;

export const roomWidgetAssertions = {
  ...roomWidgetInheritedAssertions,
  ...roomWidgetDirectAssertions,
} as const;

assert.equal(Object.keys(roomWidgetDirectAssertions).length, 86);
assert.equal(Object.keys(roomWidgetInheritedAssertions).length, 7);
assert.equal(Object.keys(roomWidgetAssertions).length, 93);
assert.equal(new Set(Object.values(roomWidgetAssertions)).size, 93);

export type RoomWidgetAssertion =
  (typeof roomWidgetAssertions)[keyof typeof roomWidgetAssertions];
