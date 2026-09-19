export const RECOVERY_RESET_SOURCES = {
  helpers: 'e2e/browser/journeys/trust/recovery-reset.spec.mts:27-74',
  replacement: 'e2e/browser/journeys/trust/recovery-reset.spec.mts:79-180',
  cancel: 'e2e/browser/journeys/trust/recovery-reset.spec.mts:182-242',
  originalKey: 'e2e/browser/journeys/trust/recovery-reset.spec.mts:244-313',
  escapeHatch: 'e2e/browser/journeys/trust/recovery-reset.spec.mts:315-362',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const recoveryResetAssertions = {
  replacement: {
    originalKeyNonempty: 'recovery-reset.replacement.original-key-nonempty',
    defaultKeyBeforeNonempty:
      'recovery-reset.replacement.default-key-before-nonempty',
    resetActionVisible: 'recovery-reset.replacement.reset-action-visible',
    warningGateVisible: 'recovery-reset.replacement.warning-gate-visible',
    backupDeletionWarning:
      'recovery-reset.replacement.backup-deletion-warning',
    fourConsequenceLines:
      'recovery-reset.replacement.four-consequence-lines',
    resetWordInstruction:
      'recovery-reset.replacement.reset-word-instruction',
    wrongWordGateHidden:
      'recovery-reset.replacement.wrong-word-gate-hidden',
    wrongWordResetReenabled:
      'recovery-reset.replacement.wrong-word-reset-reenabled',
    wrongWordDefaultKeyUnchanged:
      'recovery-reset.replacement.wrong-word-default-key-unchanged',
    wrongWordFeedback: 'recovery-reset.replacement.wrong-word-feedback',
    confirmedGateVisible:
      'recovery-reset.replacement.confirmed-gate-visible',
    recoveryKeyVisible: 'recovery-reset.replacement.recovery-key-visible',
    replacementKeyNonempty:
      'recovery-reset.replacement.replacement-key-nonempty',
    replacementKeyDifferent:
      'recovery-reset.replacement.replacement-key-different',
    acknowledgementDisabled:
      'recovery-reset.replacement.acknowledgement-disabled',
    acknowledgementEnabled:
      'recovery-reset.replacement.acknowledgement-enabled',
    defaultKeyAfterNonempty:
      'recovery-reset.replacement.default-key-after-nonempty',
    defaultKeyChanged: 'recovery-reset.replacement.default-key-changed',
    readySecurityCopy: 'recovery-reset.replacement.ready-security-copy',
    unlockActionAbsent: 'recovery-reset.replacement.unlock-action-absent',
    setupActionAbsent: 'recovery-reset.replacement.setup-action-absent',
  },
  cancel: {
    defaultKeyBeforeNonempty:
      'recovery-reset.cancel.default-key-before-nonempty',
    backupVersionBeforeNonempty:
      'recovery-reset.cancel.backup-version-before-nonempty',
    resetActionVisible: 'recovery-reset.cancel.reset-action-visible',
    resetGateVisible: 'recovery-reset.cancel.reset-gate-visible',
    passwordGateVisible: 'recovery-reset.cancel.password-gate-visible',
    recoveryKeyAbsent: 'recovery-reset.cancel.recovery-key-absent',
    resetActionReenabled:
      'recovery-reset.cancel.reset-action-reenabled',
    backupVersionUnchanged:
      'recovery-reset.cancel.backup-version-unchanged',
    defaultKeyUnchanged: 'recovery-reset.cancel.default-key-unchanged',
    readySecurityCopy: 'recovery-reset.cancel.ready-security-copy',
    unlockActionAbsent: 'recovery-reset.cancel.unlock-action-absent',
    setupActionAbsent: 'recovery-reset.cancel.setup-action-absent',
  },
  originalKey: {
    originalKeyNonempty:
      'recovery-reset.original-key.original-key-nonempty',
    defaultKeyBeforeNonempty:
      'recovery-reset.original-key.default-key-before-nonempty',
    backupVersionBeforeNonempty:
      'recovery-reset.original-key.backup-version-before-nonempty',
    masterKeyBeforeNonempty:
      'recovery-reset.original-key.master-key-before-nonempty',
    resetActionVisible: 'recovery-reset.original-key.reset-action-visible',
    resetGateVisible: 'recovery-reset.original-key.reset-gate-visible',
    passwordGateVisible:
      'recovery-reset.original-key.password-gate-visible',
    resetActionReenabled:
      'recovery-reset.original-key.reset-action-reenabled',
    unlockErrorAbsent: 'recovery-reset.original-key.unlock-error-absent',
    readySecurityCopy:
      'recovery-reset.original-key.ready-security-copy',
    unlockActionAbsent:
      'recovery-reset.original-key.unlock-action-absent',
    setupActionAbsent: 'recovery-reset.original-key.setup-action-absent',
    masterKeyUnchanged: 'recovery-reset.original-key.master-key-unchanged',
    backupVersionUnchanged:
      'recovery-reset.original-key.backup-version-unchanged',
    defaultKeyUnchanged:
      'recovery-reset.original-key.default-key-unchanged',
  },
  escapeHatch: {
    lostKeyActionVisible:
      'recovery-reset.escape-hatch.lost-key-action-visible',
    unlockActionVisible:
      'recovery-reset.escape-hatch.unlock-action-visible',
    resetGateVisible: 'recovery-reset.escape-hatch.reset-gate-visible',
    resetInstructionVisible:
      'recovery-reset.escape-hatch.reset-instruction-visible',
    owningResetActionVisible:
      'recovery-reset.escape-hatch.owning-reset-action-visible',
  },
} as const;

export type RecoveryResetAssertion = {
  [Group in keyof typeof recoveryResetAssertions]: (typeof recoveryResetAssertions)[Group][keyof (typeof recoveryResetAssertions)[Group]];
}[keyof typeof recoveryResetAssertions];
