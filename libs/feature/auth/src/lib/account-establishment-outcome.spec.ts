import { describe, expect, it } from 'vitest';
import { accountEstablishmentError } from './account-establishment-outcome';

describe('accountEstablishmentError', () => {
  it('asks to unlock the keychain and retry while it is unavailable', () => {
    expect(
      accountEstablishmentError({
        kind: 'failed',
        failure: 'secure-storage-unavailable',
        accountId: '@me:hs',
        placement: 'active',
      }),
    ).toBe(
      'Your system keychain is locked or unavailable. Unlock it and try again.',
    );
  });

  it('asks for a new sign-in when this device lost the key to its stored keys', () => {
    expect(
      accountEstablishmentError({
        kind: 'failed',
        failure: 'crypto-store-key-lost',
        accountId: '@me:hs',
        placement: 'active',
      }),
    ).toBe(
      'This device can no longer unlock this account’s stored keys. Sign in again to set it up as a new session.',
    );
  });
});
