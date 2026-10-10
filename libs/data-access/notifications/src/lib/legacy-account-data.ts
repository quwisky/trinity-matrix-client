/**
 * Account data written under the retired `eu.qwky.trinity.*` names. Reads prefer the
 * `dev.trinityproject.trinity.*` name and fall back to the old one; a one-time copy moves
 * the old value across. The old event stays on the server: account data can't be deleted.
 */
interface AccountDataReader {
  getAccountData?: (type: never) => { getContent?: () => unknown } | undefined;
}

interface AccountDataStore {
  getAccountData: (type: never) => { getContent: () => unknown } | undefined;
  setAccountData: (type: never, content: never) => Promise<unknown>;
}

/** The content under `type`, or under `legacyType` while only the old name exists. */
export function migratedAccountDataContent(
  client: AccountDataReader | null | undefined,
  type: string,
  legacyType: string,
): unknown {
  const current = client?.getAccountData?.(type as never);
  if (current) return current.getContent?.();
  return client?.getAccountData?.(legacyType as never)?.getContent?.();
}

const copying = new WeakMap<object, Set<string>>();

/**
 * Copy `legacyType` to `type` once, when only the old name exists. Never throws: a failed
 * write leaves the old value readable and is retried on the next call.
 */
export function copyLegacyAccountData(
  client: AccountDataStore,
  type: string,
  legacyType: string,
): void {
  if (client.getAccountData(type as never)) return;
  const legacy = client.getAccountData(legacyType as never);
  if (!legacy) return;
  const inFlight = copying.get(client) ?? new Set<string>();
  if (inFlight.has(type)) return;
  inFlight.add(type);
  copying.set(client, inFlight);
  void client
    .setAccountData(type as never, legacy.getContent() as never)
    .catch(() => undefined)
    .finally(() => inFlight.delete(type));
}
