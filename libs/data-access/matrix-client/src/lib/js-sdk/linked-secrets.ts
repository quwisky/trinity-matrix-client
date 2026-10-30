import type { MatrixClient } from 'matrix-js-sdk';
import type { CryptoApi } from 'matrix-js-sdk/lib/crypto-api';

type LinkedSecrets = Parameters<
  NonNullable<CryptoApi['importSecretsBundle']>
>[0];

/**
 * Imports the secrets another device shared, cross-signs this device and enables key backup.
 * Resolves whether the device ended cross-signed; errors are dropped unlogged, as they can
 * quote the secrets.
 */
export async function importLinkedSecrets(
  client: MatrixClient,
  secrets: unknown,
): Promise<boolean> {
  try {
    const crypto = client.getCrypto();
    const deviceId = client.getDeviceId();
    const userId = client.getUserId();
    if (!crypto?.importSecretsBundle || !deviceId || !userId) return false;
    // The crypto layer rejects a malformed bundle, which the catch absorbs.
    await crypto.importSecretsBundle(secrets as LinkedSecrets);
    await crypto.crossSignDevice(deviceId);
    // Best effort: backup does not decide whether the device is verified.
    await crypto.checkKeyBackupAndEnable().catch(() => undefined);
    if (!(await crypto.isCrossSigningReady())) return false;
    const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
    return status?.crossSigningVerified === true;
  } catch {
    return false;
  }
}
