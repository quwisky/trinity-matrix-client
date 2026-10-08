// Type declarations for the JavaScript homeserver harness (start.mjs).
//
// The harness is deliberately plain `.mjs`: it is also run standalone with bare `node`
// (`pnpm e2e:verify:up`, and the `node start.mjs` branch at the bottom of the file), so
// it must not need a build step. Its consumers, however, are `.mts` specs that ARE type
// checked — and without this file every import of it is an implicit `any` (TS7016), which
// is exactly the seam where a renamed credential field would go unnoticed.
//
// Keep in sync with the `return` at the end of `start()` and the exported constants.

import type {
  HomeserverFeature,
  HomeserverKind,
  HomeserverRuntime,
} from './kind.mts';

export declare const HOMESERVER_HTTP: string;
export declare const SECONDARY_HTTP: string;
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
export declare const MAS_HS_TLS: string;
export declare const MAS_SERVER_NAME: string;
export declare const MAS_ISSUER: string;
export declare const MAS_SHARED_SECRET: string;
export declare const MAS_USER: string;
export declare const MAS_PASS: string;

/** A Dex-backed account: the homeserver creates it on the first completed round-trip. */
export interface HomeserverSsoAccount {
  user: string;
  email: string;
  pass: string;
}

/** The seeded account on the opt-in MAS stack (TRINITY_E2E_MAS=1). */
export interface HomeserverMasAccount {
  /** The delegating homeserver's TLS base URL. */
  hs: string;
  serverName: string;
  /** MAS's issuer, with its trailing slash. */
  issuer: string;
  user: string;
  pass: string;
}

/** What `start()` hands back once the whole stack is up and healthy. */
export interface HomeserverHarness {
  /** Base URL of the TLS-terminating Caddy in front of the homeserver. */
  hs: string;
  user: string;
  pass: string;
  serverName: string;
  /** The server TRINITY_E2E_HOMESERVER selected, confirmed against the running one. */
  kind: HomeserverKind;
  /** Its version from `/_matrix/federation/v1/version`. */
  version: string;
  /** Docker Compose, or host processes when TRINITY_E2E_HOMESERVER_RUNTIME=native. */
  runtime: HomeserverRuntime;
  /** Features this runtime does not provide; their fields below are then absent. */
  unavailable: readonly HomeserverFeature[];
  secondary?: {
    /** Host-reachable Client-Server API for setup requests. */
    hs: string;
    /** Matrix server name reachable by the primary over federation. */
    serverName: string;
    registrationSecret: string;
  };
  sso?: HomeserverSsoAccount;
  /** A second SSO account, permanently seeded for the recovery-reset spec. */
  ssoReset?: HomeserverSsoAccount;
  mas?: HomeserverMasAccount;
  /** Caddy's local root certificate (native runtime), for hosts that must trust it. */
  caddyRoot?: string;
}

export declare function start(options?: {
  signal?: AbortSignal;
}): Promise<HomeserverHarness>;
