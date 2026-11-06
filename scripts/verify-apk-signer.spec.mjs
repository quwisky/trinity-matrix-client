import { checkSigner, signerDigests } from './verify-apk-signer.mjs';

const PINNED = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

/** `apksigner verify --verbose --print-certs` output, with fake certificates. */
const output = (...digests) =>
  [
    'Verifies',
    'Verified using v1 scheme (JAR signing): false',
    'Verified using v2 scheme (APK Signature Scheme v2): true',
    'Verified using v3 scheme (APK Signature Scheme v3): true',
    'Verified using v4 scheme (APK Signature Scheme v4): false',
    'Verified for SourceStamp: false',
    `Number of signers: ${digests.length}`,
    ...digests.flatMap((digest, i) => [
      `Signer #${i + 1} certificate DN: CN=Fake ${i + 1}`,
      `Signer #${i + 1} certificate SHA-256 digest: ${digest}`,
      `Signer #${i + 1} certificate SHA-1 digest: ${'01'.repeat(20)}`,
      `Signer #${i + 1} key algorithm: RSA`,
      `Signer #${i + 1} public key SHA-256 digest: ${'ef'.repeat(32)}`,
    ]),
    '',
  ].join('\n');

const colonUpper = (hex) => hex.toUpperCase().match(/../g).join(':');

describe('verify-apk-signer', () => {
  it('accepts the pinned signer', () => {
    expect(signerDigests(output(PINNED))).toEqual([PINNED]);
    expect(() =>
      checkSigner(output(PINNED), `${colonUpper(PINNED)}\n`),
    ).not.toThrow();
  });

  it('rejects a different signer', () => {
    expect(() => checkSigner(output(OTHER), PINNED)).toThrow(OTHER);
  });

  it('rejects multiple signers', () => {
    expect(() => checkSigner(output(PINNED, OTHER), PINNED)).toThrow(
      /exactly one signer/,
    );
  });

  it('rejects an unsigned apk', () => {
    expect(signerDigests('DOES NOT VERIFY\n')).toEqual([]);
    expect(() => checkSigner('DOES NOT VERIFY\n', PINNED)).toThrow(
      /exactly one signer/,
    );
  });

  it('asks for the digest while it is UNSET', () => {
    expect(() => checkSigner(output(PINNED), 'UNSET\n')).toThrow(
      'set the release certificate digest',
    );
  });
});
