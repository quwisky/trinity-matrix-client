import { checkSigner, signerDigests } from './verify-apk-signer.mjs';

// Verbatim `apksigner verify --print-certs` output from build-tools 37.0.0 (CI run
// 42256303463), for a throwaway CN=test key.
const REAL_V2 = `V2 Signer: certificate DN: CN=test
V2 Signer: certificate SHA-256 digest: 9a7a304d6327e9fa16083bbdb643631858259916cd29f57209e04c561c7ff22e
V2 Signer: certificate SHA-1 digest: b78784468a09a7c86ca076039651377b9929d8e7
V2 Signer: certificate MD5 digest: 676a845bfc7272a548bc0fcc6b3b5be9
`;
const PINNED =
  '9a7a304d6327e9fa16083bbdb643631858259916cd29f57209e04c561c7ff22e';
const OTHER = 'cd'.repeat(32);
const SOURCE_STAMP = 'ef'.repeat(32);

/** The same key under the v2 and v3 schemes, plus lines that must not count. */
const v2v3 = (v3Digest, signers = 1) => `Verifies
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Number of signers: ${signers}
V2 Signer: certificate DN: CN=test
V2 Signer: certificate SHA-256 digest: ${PINNED}
V2 Signer: public key SHA-256 digest: ${OTHER}
V3 Signer: certificate DN: CN=test
V3 Signer: certificate SHA-256 digest: ${v3Digest}
Source Stamp Signer: certificate SHA-256 digest: ${SOURCE_STAMP}
`;

const colonUpper = (hex) => hex.toUpperCase().match(/../g).join(':');

describe('verify-apk-signer', () => {
  it('reads every scheme and format of signer line, and nothing else', () => {
    expect(signerDigests(REAL_V2)).toEqual([PINNED]);
    expect(signerDigests(v2v3(PINNED))).toEqual([PINNED, PINNED]);
    expect(
      signerDigests(
        `Signer #1 certificate SHA-256 digest: ${PINNED}\nSigner (minSdkVersion=24, maxSdkVersion=2147483647) certificate SHA-256 digest: ${OTHER}\n`,
      ),
    ).toEqual([PINNED, OTHER]);
  });

  it('accepts the pinned signer', () => {
    expect(() => checkSigner(REAL_V2, `${colonUpper(PINNED)}\n`)).not.toThrow();
    // v2 and v3 with the same key are one signer.
    expect(() => checkSigner(v2v3(PINNED), PINNED)).not.toThrow();
  });

  it('rejects a different signer', () => {
    expect(() => checkSigner(REAL_V2, OTHER)).toThrow(PINNED);
    expect(() => checkSigner(v2v3(OTHER), PINNED)).toThrow(OTHER);
  });

  it('rejects multiple signers', () => {
    expect(() => checkSigner(v2v3(PINNED, 2), PINNED)).toThrow(
      /exactly one signer/,
    );
    expect(() =>
      checkSigner(
        `${REAL_V2}V2 Signer #2: certificate SHA-256 digest: ${PINNED}\n`,
        PINNED,
      ),
    ).toThrow(/exactly one signer/);
  });

  it('rejects an unsigned apk', () => {
    expect(signerDigests('DOES NOT VERIFY\n')).toEqual([]);
    expect(() => checkSigner('DOES NOT VERIFY\n', PINNED)).toThrow(
      /exactly one signer/,
    );
  });

  it('asks for the digest while it is UNSET', () => {
    expect(() => checkSigner(REAL_V2, 'UNSET\n')).toThrow(
      'set the release certificate digest',
    );
  });
});
