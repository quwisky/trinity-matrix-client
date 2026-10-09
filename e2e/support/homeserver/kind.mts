/** The homeservers the E2E stack can run; the first is the default. */
export const HOMESERVER_KINDS = ['tuwunel', 'synapse'] as const;
export type HomeserverKind = (typeof HOMESERVER_KINDS)[number];

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
export const HOMESERVER_FEATURES = ['remote', 'sso'] as const;
export type HomeserverFeature = (typeof HOMESERVER_FEATURES)[number];

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
