// Type declarations for the JavaScript Synapse harness (start.mjs).
//
// The harness is deliberately plain `.mjs`: it is also run standalone with bare `node`
// (`pnpm e2e:verify:up`, and the `node start.mjs` branch at the bottom of the file), so
// it must not need a build step. Its consumers, however, are `.mts` specs that ARE type
// checked — and without this file every import of it is an implicit `any` (TS7016), which
// is exactly the seam where a renamed credential field would go unnoticed.
//
// Keep in sync with the `return` at the end of `start()` and the exported constants.

export declare const SYNAPSE_HTTP: string;
export declare const HS_TLS: string;
export declare const SERVER_NAME: string;
export declare const REGISTRATION_SHARED_SECRET: string;
export declare const TEST_USER: string;
export declare const TEST_PASS: string;
export declare const DEX_ISSUER: string;
export declare const SSO_EMAIL: string;
export declare const SSO_PASS: string;
export declare const SSO_USER: string;
export declare const SSO_RESET_EMAIL: string;
export declare const SSO_RESET_USER: string;

/** A Dex-backed account: Synapse creates it on the first completed round-trip. */
export interface SynapseSsoAccount {
  user: string;
  email: string;
  pass: string;
}

/** What `start()` hands back once the whole stack is up and healthy. */
export interface SynapseHarness {
  /** Base URL of the TLS-terminating Caddy in front of Synapse. */
  hs: string;
  user: string;
  pass: string;
  serverName: string;
  sso: SynapseSsoAccount;
  /** A second SSO account, permanently seeded for the recovery-reset spec. */
  ssoReset: SynapseSsoAccount;
}

export declare function start(options?: {
  signal?: AbortSignal;
}): Promise<SynapseHarness>;
