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
