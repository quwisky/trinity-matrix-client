// Addresses and credentials of the disposable e2e homeserver stack, shared by the driver
// (start.mjs), the adapters and the specs (re-exported from start.mjs).

/** The stack's ports at TRINITY_E2E_PORT_OFFSET=0, which Docker, MAS and mobile always use. */
const BASE_PORTS = {
  homeserver: 8008,
  secondary: 8009,
  tls: 8448,
  identity: 8452,
  sydent: 8090,
  dex: 5556,
  mailpit: 8025,
  smtp: 1025,
  linkPreview: 8080,
  masHomeserver: 8450,
  masIssuer: 8451,
};
const MAX_PORT_OFFSET = 65535 - Math.max(...Object.values(BASE_PORTS));

/**
 * TRINITY_E2E_PORT_OFFSET, added to every port of the native stack so stacks from several
 * checkouts can run at once. Unset or empty is 0.
 */
export function resolvePortOffset(env = process.env) {
  const value = env.TRINITY_E2E_PORT_OFFSET ?? '';
  if (value === '') return 0;
  if (!/^\d+$/.test(value) || Number(value) > MAX_PORT_OFFSET) {
    throw new Error(
      `Invalid TRINITY_E2E_PORT_OFFSET "${value}"; expected an integer from 0 to ${MAX_PORT_OFFSET}`,
    );
  }
  return Number(value);
}

export const PORT_OFFSET = resolvePortOffset();
export const PORTS = Object.fromEntries(
  Object.entries(BASE_PORTS).map(([name, port]) => [name, port + PORT_OFFSET]),
);

/** Shift every `:<base port>` in a committed config to its offset port. */
export function offsetPorts(text, offset = PORT_OFFSET) {
  if (offset === 0) return text;
  const base = new Set(Object.values(BASE_PORTS));
  return text.replace(/:(\d{4})\b/g, (match, port) =>
    base.has(Number(port)) ? `:${Number(port) + offset}` : match,
  );
}

export const HOMESERVER_HTTP = `http://localhost:${PORTS.homeserver}`;
export const SECONDARY_HTTP = `http://localhost:${PORTS.secondary}`;
export const HS_TLS = `https://localhost:${PORTS.tls}`;
export const SERVER_NAME = 'localhost';
export const REGISTRATION_SHARED_SECRET = 'trinity-e2e-shared-secret';

// Test credentials the verify-sas runner logs in with on both contexts.
export const TEST_USER = process.env.TRINITY_USER ?? 'verify-e2e';
export const TEST_PASS = process.env.TRINITY_PASS ?? 'verify-e2e-pass-123';

// The Dex-backed SSO account. It has no Matrix password by construction — the
// homeserver creates it on the first SSO round-trip — which is exactly what the specs
// need it for.
// These must match e2e/support/homeserver/dex.yaml.
export const DEX_ISSUER = `http://localhost:${PORTS.dex}/dex`;

// Mailpit's HTTP API, where the specs read the mail the homeserver sends. Synapse reaches
// its SMTP listener on PORTS.smtp (see synapse/adapter.mjs).
export const MAILPIT_HTTP = `http://127.0.0.1:${PORTS.mailpit}`;
// Sydent, the identity server of the Synapse stack, behind Caddy's TLS. The browser and
// Synapse both use this URL; Sydent itself listens on 127.0.0.1:PORTS.sydent (see sydent/).
export const IDENTITY_SERVER_URL = `https://localhost:${PORTS.identity}`;
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

// A third Dex identity, which the account-deletion journey deletes on the homeserver. A
// deleted Matrix ID is never released, so no other spec may use it.
export const SSO_DELETE_EMAIL = 'sso-delete-e2e@trinity.test';
export const SSO_DELETE_USER = 'sso-delete-e2e';

// The opt-in MAS stack (TRINITY_E2E_MAS=1, see mas/). Must match mas/mas.yaml and the
// Caddyfile. The account is seeded through MAS's CLI; Synapse never sees a password.
export const MAS_HS_TLS = `https://localhost:${PORTS.masHomeserver}`;
export const MAS_SERVER_NAME = `localhost:${PORTS.masHomeserver}`;
export const MAS_ISSUER = `https://localhost:${PORTS.masIssuer}/`;
export const MAS_SHARED_SECRET = 'trinity-e2e-mas-shared-secret';
export const MAS_USER = 'mas-e2e';
export const MAS_PASS = 'mas-e2e-pass-123';
