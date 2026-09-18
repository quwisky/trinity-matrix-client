export const SSO_RECOVERY_RESET_SOURCES = {
  availability:
    'e2e/browser/journeys/trust/sso-recovery-reset.spec.mts:34-46',
  refusal: 'e2e/browser/journeys/trust/sso-recovery-reset.spec.mts:48-107',
  keyBackup:
    'e2e/browser/journeys/trust/sso-recovery-reset.spec.mts:110-140',
  account: 'e2e/support/account.mts',
  ssoHelper: 'e2e/browser/support/sso.mts',
  app: 'e2e/support/app.mts',
  dex: 'e2e/support/synapse/dex.yaml',
} as const;

export const ssoRecoveryResetAssertions = {
  masterKeyBeforeNonempty:
    'sso-recovery-reset.master-key-before-nonempty',
  backupVersionBeforeNonempty:
    'sso-recovery-reset.backup-version-before-nonempty',
  resetActionVisible: 'sso-recovery-reset.reset-action-visible',
  resetGateVisible: 'sso-recovery-reset.reset-gate-visible',
  identityProviderRefusalCopy:
    'sso-recovery-reset.identity-provider-refusal-copy',
  recoveryKeyAbsent: 'sso-recovery-reset.recovery-key-absent',
  passwordPromptAbsent: 'sso-recovery-reset.password-prompt-absent',
  masterKeyUnchanged: 'sso-recovery-reset.master-key-unchanged',
  backupVersionUnchanged: 'sso-recovery-reset.backup-version-unchanged',
} as const;

export type SsoRecoveryResetAssertion =
  (typeof ssoRecoveryResetAssertions)[keyof typeof ssoRecoveryResetAssertions];
