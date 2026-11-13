import { describe, expect, it } from 'vitest';
import { deriveVerifyBlock } from './verify-block';

const BASE = {
  status: 'needs-recovery',
  thisDeviceVerified: false,
  identityElsewhere: false,
  recoveryHoldsKeys: true,
} as const;

describe('deriveVerifyBlock', () => {
  // `ready` is the state Security settings has no action for: recovery exists, the device
  // is verified, and the user-signing key was never fetched.
  it.each(['ready', 'needs-recovery'] as const)(
    'offers the recovery key when recovery holds the keys and the status is %s',
    (status) => {
      expect(deriveVerifyBlock({ ...BASE, status })).toEqual({
        reason:
          'This device doesn’t have all its keys yet. Enter your recovery key to verify people.',
        action: { label: 'Enter recovery key', flow: 'unlock' },
      });
    },
  );

  // The recovery key would be refused there, and a verified device has nothing else to try.
  it('offers no recovery key, and no reset, on a verified device whose recovery lacks the keys', () => {
    expect(
      deriveVerifyBlock({
        ...BASE,
        thisDeviceVerified: true,
        recoveryHoldsKeys: false,
      }),
    ).toEqual({
      reason:
        'Verify people from the device where you set up encryption, or set up recovery there.',
      action: null,
    });
  });

  it('offers verification on an unverified device whose recovery lacks the keys', () => {
    expect(deriveVerifyBlock({ ...BASE, recoveryHoldsKeys: false })).toEqual({
      reason: 'Verify this device before you verify people.',
      action: { label: 'Verify this device', flow: 'verify' },
    });
  });

  it('offers verification when the identity is on another device and there is no recovery', () => {
    expect(
      deriveVerifyBlock({
        ...BASE,
        status: 'needs-verification',
        identityElsewhere: true,
        recoveryHoldsKeys: false,
      }),
    ).toEqual({
      reason: 'Verify this device before you verify people.',
      action: { label: 'Verify this device', flow: 'verify' },
    });
  });

  it('offers setup when nothing is set up anywhere', () => {
    expect(
      deriveVerifyBlock({
        ...BASE,
        status: 'needs-setup',
        recoveryHoldsKeys: false,
      }),
    ).toEqual({
      reason: 'Set up encryption on this device to verify people.',
      action: { label: 'Set up encryption', flow: 'setup' },
    });
  });

  // The only thing this device could do there is replace the identity.
  it('offers nothing, least of all a reset, when the keys are only on another device', () => {
    expect(
      deriveVerifyBlock({
        status: 'needs-setup',
        thisDeviceVerified: true,
        identityElsewhere: true,
        recoveryHoldsKeys: false,
      }),
    ).toEqual({
      reason:
        'Verify people from the device where you set up encryption, or set up recovery there.',
      action: null,
    });
  });
});
