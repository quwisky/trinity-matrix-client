// Fixed addresses and credentials of the disposable e2e homeserver stack, shared by
// the driver (start.mjs), the adapters and the specs (re-exported from start.mjs).

export const HOMESERVER_HTTP = 'http://localhost:8008';
export const SECONDARY_HTTP = 'http://localhost:8009';
export const HS_TLS = 'https://localhost:8448';
export const SERVER_NAME = 'localhost';
export const REGISTRATION_SHARED_SECRET = 'trinity-e2e-shared-secret';

// Test credentials the verify-sas runner logs in with on both contexts.
export const TEST_USER = process.env.TRINITY_USER ?? 'verify-e2e';
export const TEST_PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';

// The Dex-backed SSO account. It has no Matrix password by construction — the
// homeserver creates it on the first SSO round-trip — which is exactly what the specs
// need it for.
// These must match e2e/support/homeserver/dex.yaml.
export const DEX_ISSUER = 'http://localhost:5556/dex';
export const SSO_EMAIL = 'sso-e2e@trinity.test';
export const SSO_PASS = 'sso-e2e-pass-123';
/**
 * Localpart the homeserver derives from the Dex identity: Synapse via
 * `localpart_template`, Tuwunel via `userid_claims = ["email"]`.
 */
export const SSO_USER = 'sso-e2e';

// A second Dex identity, reserved for the recovery-reset spec. It is the only SSO spec
// that leaves permanent state on its account (a cross-signing master key and a key-backup
// version, neither removable), and its assertions are all "this did not change" — which
// only means anything on an account no other worker is touching. Dex's static user list
// is fixed at container start, so this is the finest isolation available: see dex.yaml.
export const SSO_RESET_EMAIL = 'sso-reset-e2e@trinity.test';
export const SSO_RESET_USER = 'sso-reset-e2e';

// The opt-in MAS stack (TRINITY_E2E_MAS=1, see mas/). Must match mas/mas.yaml and the
// Caddyfile. The account is seeded through MAS's CLI; Synapse never sees a password.
export const MAS_HS_TLS = 'https://localhost:8450';
export const MAS_SERVER_NAME = 'localhost:8450';
export const MAS_ISSUER = 'https://localhost:8451/';
export const MAS_SHARED_SECRET = 'trinity-e2e-mas-shared-secret';
export const MAS_USER = 'mas-e2e';
export const MAS_PASS = 'mas-e2e-pass-123';
