import type { TrustHealthSnapshot } from './trust-health.service';

/** What stands where Verify would be: a reason, and the trust flow that fixes it, if any. */
export interface VerifyBlock {
  readonly reason: string;
  readonly action: {
    readonly label: string;
    readonly flow: 'setup' | 'unlock' | 'verify';
  } | null;
}

const ENTER_RECOVERY_KEY: VerifyBlock = {
  reason:
    'This device doesn’t have all its keys yet. Enter your recovery key to verify people.',
  action: { label: 'Enter recovery key', flow: 'unlock' },
};
const VERIFY_THIS_DEVICE: VerifyBlock = {
  reason: 'Verify this device before you verify people.',
  action: { label: 'Verify this device', flow: 'verify' },
};
const SET_UP_ENCRYPTION: VerifyBlock = {
  reason: 'Set up encryption on this device to verify people.',
  action: { label: 'Set up encryption', flow: 'setup' },
};
// No action: the only one this device could offer is replacing the identity.
const KEYS_ON_ANOTHER_DEVICE: VerifyBlock = {
  reason:
    'Verify people from the device where you set up encryption, or set up recovery there.',
  action: null,
};

/**
 * Why a device without its user-signing key cannot verify people, and the existing flow
 * that brings the key here. With recovery (`ready` included: secret storage counts as
 * ready without the keys being on this device) that is the recovery key, unless recovery
 * does not hold the keys: then the key would be refused, and only another device helps.
 */
export function deriveVerifyBlock(
  snapshot: Pick<
    TrustHealthSnapshot,
    'status' | 'thisDeviceVerified' | 'identityElsewhere' | 'recoveryHoldsKeys'
  >,
): VerifyBlock {
  switch (snapshot.status) {
    case 'ready':
    case 'needs-recovery':
      if (snapshot.recoveryHoldsKeys) {
        return ENTER_RECOVERY_KEY;
      }
      return snapshot.thisDeviceVerified
        ? KEYS_ON_ANOTHER_DEVICE
        : VERIFY_THIS_DEVICE;
    case 'needs-verification':
      return VERIFY_THIS_DEVICE;
    case 'needs-setup':
      return snapshot.thisDeviceVerified && snapshot.identityElsewhere
        ? KEYS_ON_ANOTHER_DEVICE
        : SET_UP_ENCRYPTION;
  }
}
