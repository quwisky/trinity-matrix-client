import { resolvePortOffset } from './constants.mjs';

/**
 * The homeservers the E2E stack can run; the first is the default. `tuwunel-oauth` is
 * Tuwunel with its built-in OAuth server and QR sign-in, and no SSO.
 */
export const HOMESERVER_KINDS = [
  'tuwunel',
  'synapse',
  'tuwunel-oauth',
] as const;
export type HomeserverKind = (typeof HOMESERVER_KINDS)[number];

/** Whether the kind runs Tuwunel, whose server quirks the specs work around. */
export function isTuwunel(kind: HomeserverKind | undefined): boolean {
  return kind === 'tuwunel' || kind === 'tuwunel-oauth';
}

/**
 * The homeserver selected by `TRINITY_E2E_HOMESERVER`, defaulting to Tuwunel.
 *
 * Exact match only: a typo must fail before Docker starts, not quietly run the default.
 */
export function resolveHomeserverKind(
  env: NodeJS.ProcessEnv = process.env,
): HomeserverKind {
  const value = env['TRINITY_E2E_HOMESERVER'] || HOMESERVER_KINDS[0];
  if (!(HOMESERVER_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown TRINITY_E2E_HOMESERVER "${value}"; expected one of: ${HOMESERVER_KINDS.join(', ')}`,
    );
  }
  return value as HomeserverKind;
}

/** How the harness runs the server: Docker Compose (default) or host processes. */
export const HOMESERVER_RUNTIMES = ['docker', 'native'] as const;
export type HomeserverRuntime = (typeof HOMESERVER_RUNTIMES)[number];

/** Harness features a runtime may not provide; a session lists the missing ones. */
export const HOMESERVER_FEATURES = [
  'remote',
  'sso',
  'mail',
  'identity',
] as const;
export type HomeserverFeature = (typeof HOMESERVER_FEATURES)[number];

/** The features a session lacks, in HOMESERVER_FEATURES order. */
export function unavailableFeatures(
  available: Readonly<Record<HomeserverFeature, boolean>>,
): HomeserverFeature[] {
  return HOMESERVER_FEATURES.filter((feature) => !available[feature]);
}

/**
 * Wait for an optional service: a failed wait makes it unavailable instead of failing the
 * stack. An aborted operation still throws.
 */
export async function optionalReady(
  wait: () => Promise<void>,
  {
    name,
    log,
    signal,
  }: {
    readonly name: string;
    readonly log: (message: string) => void;
    readonly signal?: AbortSignal;
  },
): Promise<boolean> {
  try {
    await wait();
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    log(`${name} did not become ready, so it is unavailable`);
    return false;
  }
}

/**
 * The runtime selected by `TRINITY_E2E_HOMESERVER_RUNTIME`, defaulting to Docker.
 *
 * Native runs Synapse from a venv and Caddy as host processes, for hosts without Docker
 * (the macOS runner the iOS suite needs). Tuwunel has no macOS build, so native is
 * Synapse-only, and that is checked here, before any lock or process exists.
 */
export function resolveHomeserverRuntime(
  env: NodeJS.ProcessEnv = process.env,
): HomeserverRuntime {
  const value = env['TRINITY_E2E_HOMESERVER_RUNTIME'] || HOMESERVER_RUNTIMES[0];
  if (!(HOMESERVER_RUNTIMES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown TRINITY_E2E_HOMESERVER_RUNTIME "${value}"; expected one of: ${HOMESERVER_RUNTIMES.join(', ')}`,
    );
  }
  // shortcut: Docker and its MAS overlay publish fixed ports; offset their compose files
  // when Docker runs need to share a machine too.
  if (value !== 'native' && resolvePortOffset(env) !== 0) {
    throw new Error(
      'TRINITY_E2E_PORT_OFFSET needs TRINITY_E2E_HOMESERVER_RUNTIME=native; the Docker stack uses fixed ports',
    );
  }
  if (value === 'native' && resolveHomeserverKind(env) !== 'synapse') {
    throw new Error(
      'TRINITY_E2E_HOMESERVER_RUNTIME=native runs Synapse only; set TRINITY_E2E_HOMESERVER=synapse',
    );
  }
  return value as HomeserverRuntime;
}

/**
 * Whether `TRINITY_E2E_MAS=1` asked for the opt-in MAS stack (mas/docker-compose.yml).
 * Exact values only, like the selectors above. MAS runs in Docker, so native refuses it.
 */
export function resolveMasEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env['TRINITY_E2E_MAS'] ?? '';
  if (value !== '' && value !== '0' && value !== '1') {
    throw new Error(`Unknown TRINITY_E2E_MAS "${value}"; expected 1 or 0`);
  }
  if (value === '1' && resolveHomeserverRuntime(env) === 'native') {
    throw new Error('TRINITY_E2E_MAS=1 needs the Docker runtime');
  }
  return value === '1';
}

/**
 * Whether `TRINITY_E2E_SSO_PROVIDER=mock` asked Dex to sign in through its `mockCallback`
 * connector, which answers without a login form. The iOS runner sets it: the Simulator
 * drops keystrokes typed into the Safari view. Only the native runtime writes its own
 * dex.yaml, so Docker refuses it rather than quietly keeping the password form.
 */
export function resolveSsoMock(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['TRINITY_E2E_SSO_PROVIDER'] ?? '';
  if (value !== '' && value !== 'mock') {
    throw new Error(
      `Unknown TRINITY_E2E_SSO_PROVIDER "${value}"; expected mock, or unset for Dex's password form`,
    );
  }
  if (value === 'mock' && resolveHomeserverRuntime(env) !== 'native') {
    throw new Error(
      'TRINITY_E2E_SSO_PROVIDER=mock needs the native runtime: set TRINITY_E2E_HOMESERVER=synapse and TRINITY_E2E_HOMESERVER_RUNTIME=native',
    );
  }
  return value === 'mock';
}
