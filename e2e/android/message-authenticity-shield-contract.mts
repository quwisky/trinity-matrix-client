import assert from 'node:assert/strict';

export const MESSAGE_AUTHENTICITY_SHIELD_SOURCES = {
  helpers: 'e2e/browser/journeys/trust/message-shield.spec.mts:23-69',
  plaintext: 'e2e/browser/journeys/trust/message-shield.spec.mts:74-138',
  shielded: 'e2e/browser/journeys/trust/message-shield.spec.mts:140-318',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const messageAuthenticityShieldAssertions = {
  plaintext: {
    messageVisible: 'message-authenticity.plaintext.message-visible',
    shieldAbsent: 'message-authenticity.plaintext.shield-absent',
  },
  shield: {
    roomCreated: 'message-authenticity.shield.room-created',
    secondaryMessageVisible:
      'message-authenticity.shield.secondary-message-visible',
    primaryMessageVisible: 'message-authenticity.shield.primary-message-visible',
    shieldVisible: 'message-authenticity.shield.visible',
    eventIdNonempty: 'message-authenticity.shield.event-id-nonempty',
    receiptResponseOk: 'message-authenticity.shield.receipt-response-ok',
    receiptVisible: 'message-authenticity.shield.receipt-visible',
    receiptReaderLabel: 'message-authenticity.shield.receipt-reader-label',
    nativeTitleAbsent: 'message-authenticity.shield.native-title-absent',
    focusableTabindex: 'message-authenticity.shield.focusable-tabindex',
    tooltipVisible: 'message-authenticity.shield.tooltip-visible',
    tooltipReasonNonempty:
      'message-authenticity.shield.tooltip-reason-nonempty',
    tooltipDetailNonempty:
      'message-authenticity.shield.tooltip-detail-nonempty',
    ariaDescribed: 'message-authenticity.shield.aria-described',
    copyDoesNotOverstate:
      'message-authenticity.shield.copy-does-not-overstate',
    geometryObservationComplete:
      'message-authenticity.geometry.observation-complete',
    shieldBodyChild: 'message-authenticity.geometry.shield-body-child',
    receiptBodyChild: 'message-authenticity.geometry.receipt-body-child',
    shieldTrailingEdge: 'message-authenticity.geometry.shield-trailing-edge',
    receiptTrailingEdge:
      'message-authenticity.geometry.receipt-trailing-edge',
    contentShieldNonoverlap:
      'message-authenticity.geometry.content-shield-nonoverlap',
    receiptContentNonoverlap:
      'message-authenticity.geometry.receipt-content-nonoverlap',
    receiptShieldNonoverlap:
      'message-authenticity.geometry.receipt-shield-nonoverlap',
    receiptWithinRow: 'message-authenticity.geometry.receipt-within-row',
  },
} as const;

const assertionIds = [
  ...Object.values(messageAuthenticityShieldAssertions.plaintext),
  ...Object.values(messageAuthenticityShieldAssertions.shield),
] as const;

type PlaintextAssertion =
  (typeof messageAuthenticityShieldAssertions.plaintext)[keyof typeof messageAuthenticityShieldAssertions.plaintext];
type ShieldAssertion =
  (typeof messageAuthenticityShieldAssertions.shield)[keyof typeof messageAuthenticityShieldAssertions.shield];

export type MessageAuthenticityShieldAssertion =
  | PlaintextAssertion
  | ShieldAssertion;

export const messageAuthenticityGeometryAssertions = Object.values(
  messageAuthenticityShieldAssertions.shield,
).slice(-9) as readonly MessageAuthenticityShieldAssertion[];

export const MESSAGE_AUTHENTICITY_SHIELD_ASSERTION_RECORDS =
  assertionIds.length + messageAuthenticityGeometryAssertions.length;

assert.equal(
  assertionIds.length,
  26,
  'Message-authenticity shields own exactly 26 direct assertion identities',
);
assert.equal(
  new Set(assertionIds).size,
  26,
  'Message-authenticity shield assertion identities must be unique',
);
assert.equal(
  MESSAGE_AUTHENTICITY_SHIELD_ASSERTION_RECORDS,
  35,
  'Message-authenticity shields own exactly 35 stage-local records',
);
