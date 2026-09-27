// The disposable Synapse harness's fixed credentials. They live apart from
// start.mjs so the publication scrub can redact them without loading the
// harness lifecycle.

export const REGISTRATION_SHARED_SECRET = 'trinity-e2e-shared-secret';

// Test credentials the verify-sas runner logs in with on both contexts.
export const TEST_USER = process.env.TRINITY_USER ?? 'verify-e2e';
export const TEST_PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';

// The Dex-backed SSO account's password. It must match e2e/support/synapse/dex.yaml.
export const SSO_PASS = 'sso-e2e-pass-123';

/** Every fixed secret of the harness, which published diagnostics never carry. */
export const HARNESS_SECRETS = Object.freeze([
  TEST_PASS,
  SSO_PASS,
  REGISTRATION_SHARED_SECRET,
]);
