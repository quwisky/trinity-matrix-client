import { describe, expect, it } from 'vitest';
import type { TrustFacts } from './trust-engine';
import {
  deriveTrustSnapshot,
  holdsCrossSigningIdentity,
} from './trust-snapshot';

interface AccountState {
  crossSigningReady?: boolean;
  secretStorageReady?: boolean;
  backupActive?: boolean;
  defaultKey?: boolean;
  deviceVerified?: boolean;
  publicKeysOnDevice?: boolean;
  privates?: { master: boolean; selfSigning: boolean; userSigning: boolean };
}

function facts(state: AccountState = {}): TrustFacts {
  const privates = state.privates ?? {
    master: false,
    selfSigning: false,
    userSigning: false,
  };
  return {
    crossSigningReady: state.crossSigningReady ?? false,
    secretStorageReady: state.secretStorageReady ?? false,
    keyBackupActive: state.backupActive ?? false,
    hasDefaultKey: state.defaultKey ?? false,
    thisDeviceCrossSigned: state.deviceVerified ?? false,
    crossSigning: {
      publicKeysOnDevice: state.publicKeysOnDevice ?? false,
      privateKeysInSecretStorage: false,
      privateKeysCachedLocally: {
        masterKey: privates.master,
        selfSigningKey: privates.selfSigning,
        userSigningKey: privates.userSigning,
      },
    },
  };
}

const ALL_PRIVATES = { master: true, selfSigning: true, userSigning: true };

describe('deriveTrustSnapshot', () => {
  it('is ready when cross-signing and secret storage are both ready', () => {
    const snapshot = deriveTrustSnapshot(
      facts({
        crossSigningReady: true,
        secretStorageReady: true,
        backupActive: true,
        deviceVerified: true,
        defaultKey: true,
      }),
    );

    expect(snapshot).toEqual({
      status: 'ready',
      keyBackupActive: true,
      thisDeviceVerified: true,
      identityElsewhere: false,
    });
  });

  it('needs recovery when the account has secret storage this device has not unlocked', () => {
    const snapshot = deriveTrustSnapshot(
      facts({
        defaultKey: true,
        publicKeysOnDevice: true,
      }),
    );

    expect(snapshot).toMatchObject({
      status: 'needs-recovery',
    });
  });

  it('needs verification when another device published an identity and there is no recovery', () => {
    const snapshot = deriveTrustSnapshot(facts({ publicKeysOnDevice: true }));

    expect(snapshot).toMatchObject({
      status: 'needs-verification',
      thisDeviceVerified: false,
      identityElsewhere: true,
    });
  });

  it('needs setup when the account has no identity at all', () => {
    const snapshot = deriveTrustSnapshot(facts());

    expect(snapshot).toMatchObject({
      status: 'needs-setup',
    });
  });

  it('needs setup when this device holds the identity and only recovery is missing', () => {
    // A device that completed setup: its privates verify the published identity.
    const snapshot = deriveTrustSnapshot(
      facts({
        publicKeysOnDevice: true,
        privates: ALL_PRIVATES,
        crossSigningReady: true,
        deviceVerified: true,
      }),
    );

    expect(snapshot).toMatchObject({
      status: 'needs-setup',
      identityElsewhere: false,
    });
  });

  // A reset cancelled at the password prompt rotates all three privates in the olm
  // machine and never uploads them, so the own identity does not verify against them.
  // Those privates are not the identity: offering setup here would store them in 4S.
  it('does not count privates that fail to verify the published identity as holding it', () => {
    const snapshot = deriveTrustSnapshot(
      facts({
        publicKeysOnDevice: true,
        privates: ALL_PRIVATES,
        crossSigningReady: false,
      }),
    );

    expect(snapshot).toMatchObject({
      status: 'needs-verification',
      identityElsewhere: true,
    });
  });

  it('says a verified device holding stranded privates still lacks the identity', () => {
    const snapshot = deriveTrustSnapshot(
      facts({
        publicKeysOnDevice: true,
        privates: ALL_PRIVATES,
        crossSigningReady: false,
        deviceVerified: true,
      }),
    );

    expect(snapshot).toMatchObject({
      thisDeviceVerified: true,
      identityElsewhere: true,
    });
  });

  it('does not ask a device that is already verified to verify again', () => {
    const snapshot = deriveTrustSnapshot(
      facts({
        publicKeysOnDevice: true,
        deviceVerified: true,
      }),
    );

    expect(snapshot).toMatchObject({
      status: 'needs-setup',
      thisDeviceVerified: true,
    });
  });

  // A device verified by another one, on an Account without secret storage, never
  // receives the cross-signing privates (matrix-js-sdk 43 does not request missing
  // secrets after verification). Setup here would replace the identity, so consumers
  // need to know that only the holding device can set up recovery.
  it('says the identity is held elsewhere when a verified device lacks its private keys', () => {
    const snapshot = deriveTrustSnapshot(
      facts({
        publicKeysOnDevice: true,
        deviceVerified: true,
      }),
    );

    expect(snapshot).toMatchObject({
      status: 'needs-setup',
      thisDeviceVerified: true,
      identityElsewhere: true,
    });
  });

  it('does not say the identity is held elsewhere when there is none or this device holds it', () => {
    const none = deriveTrustSnapshot(facts({ deviceVerified: true }));
    const held = deriveTrustSnapshot(
      facts({
        publicKeysOnDevice: true,
        deviceVerified: true,
        privates: ALL_PRIVATES,
        crossSigningReady: true,
      }),
    );

    expect(none).toMatchObject({
      status: 'needs-setup',
      identityElsewhere: false,
    });
    expect(held).toMatchObject({
      status: 'needs-setup',
      identityElsewhere: false,
    });
  });

  it('only reports the identity as held elsewhere when the account has no recovery', () => {
    // With secret storage the privates are reachable through recovery, so "elsewhere"
    // would mislead: the answer there is the recovery key, not the other device.
    const snapshot = deriveTrustSnapshot(
      facts({
        defaultKey: true,
        publicKeysOnDevice: true,
      }),
    );

    expect(snapshot).toMatchObject({
      status: 'needs-recovery',
      identityElsewhere: false,
    });
  });
});

describe('identityElsewhere', () => {
  const elsewhere = (state: AccountState) =>
    deriveTrustSnapshot(facts(state)).identityElsewhere;

  it('is true when this device holds only some of the private keys', () => {
    expect(
      elsewhere({
        ...{
          publicKeysOnDevice: true,
          privates: { master: true, selfSigning: false, userSigning: true },
        },
        crossSigningReady: false,
      }),
    ).toBe(true);
  });

  it('is true when this device holds all three privates but they do not match', () => {
    expect(
      elsewhere({
        ...{
          publicKeysOnDevice: true,
          privates: ALL_PRIVATES,
        },
        crossSigningReady: false,
      }),
    ).toBe(true);
  });

  it('is false when this device holds the matching private keys', () => {
    expect(
      elsewhere({
        ...{
          publicKeysOnDevice: true,
          privates: ALL_PRIVATES,
        },
        crossSigningReady: true,
      }),
    ).toBe(false);
  });

  it('is false when the account has no published identity', () => {
    expect(
      elsewhere({ ...{ privates: ALL_PRIVATES }, crossSigningReady: false }),
    ).toBe(false);
  });
});

describe('holdsCrossSigningIdentity', () => {
  const status = (
    master: boolean,
    selfSigning: boolean,
    userSigning: boolean,
  ) => ({
    publicKeysOnDevice: true,
    privateKeysInSecretStorage: false,
    privateKeysCachedLocally: {
      masterKey: master,
      selfSigningKey: selfSigning,
      userSigningKey: userSigning,
    },
  });

  it('is true only when all three private keys are cached locally', () => {
    expect(holdsCrossSigningIdentity(status(true, true, true), true)).toBe(
      true,
    );
    expect(holdsCrossSigningIdentity(status(true, true, false), true)).toBe(
      false,
    );
    expect(holdsCrossSigningIdentity(status(false, false, false), true)).toBe(
      false,
    );
  });

  it('is false for a full set of privates the published identity does not verify', () => {
    expect(holdsCrossSigningIdentity(status(true, true, true), false)).toBe(
      false,
    );
  });
});
