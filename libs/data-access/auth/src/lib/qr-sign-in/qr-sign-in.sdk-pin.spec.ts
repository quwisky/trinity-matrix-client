import * as rendezvous from 'matrix-js-sdk/lib/rendezvous';
import { describe, expect, it } from 'vitest';

// The rendezvous module is experimental; this fails when an SDK upgrade renames what the
// QR sign-in adapter uses.
describe('matrix-js-sdk rendezvous exports', () => {
  it.each([
    'MSC4108SignInWithQR',
    'MSC4108SecureChannel',
    'MSC4108RendezvousSession',
    'MSC4108FailureReason',
    'ClientRendezvousFailureReason',
    'RendezvousError',
    'isSignInWithQRAvailable',
  ])('exports %s', (name) => {
    expect(rendezvous).toHaveProperty(name);
  });

  it.each([
    'generateCode',
    'negotiateProtocols',
    'deviceAuthorizationGrant',
    'completeLoginOnNewDevice',
    'shareSecrets',
    'cancel',
    'close',
  ])('MSC4108SignInWithQR has %s', (method) => {
    expect(
      typeof (rendezvous.MSC4108SignInWithQR.prototype as never)[method],
    ).toBe('function');
  });

  it('MSC4108SignInWithQR exposes code and checkCode', () => {
    const proto = rendezvous.MSC4108SignInWithQR.prototype;
    expect(Object.getOwnPropertyDescriptor(proto, 'code')?.get).toBeTypeOf(
      'function',
    );
    expect(Object.getOwnPropertyDescriptor(proto, 'checkCode')?.get).toBeTypeOf(
      'function',
    );
  });

  it('keeps the failure reasons the flows send', () => {
    expect(rendezvous.MSC4108FailureReason.UserCancelled).toBe(
      'user_cancelled',
    );
    expect(
      rendezvous.ClientRendezvousFailureReason.InsecureChannelDetected,
    ).toBe('insecure_channel_detected');
  });
});
