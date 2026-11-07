import { checkSigner, signerDigests } from './verify-apk-signer.mjs';

// Verbatim `apksigner verify --print-certs` output from build-tools 37.0.0 (CI run
// 42256303463), for a throwaway CN=test key.
const REAL_V2 = `V2 Signer: certificate DN: CN=test
V2 Signer: certificate SHA-256 digest: 9a7a304d6327e9fa16083bbdb643631858259916cd29f57209e04c561c7ff22e
V2 Signer: certificate SHA-1 digest: b78784468a09a7c86ca076039651377b9929d8e7
V2 Signer: certificate MD5 digest: 676a845bfc7272a548bc0fcc6b3b5be9
`;
// Verbatim `apksigner verify --verbose --print-certs` output, which verify-apk-signer.mjs reads, from
// CI run 42262149458 (build-tools 37.0.0) for a throwaway CN=proof key.
const REAL_VERBOSE = `Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Verified using v3.1 scheme (APK Signature Scheme v3.1): false
Verified using v3.2 scheme (APK Signature Scheme v3.2): false
Verified using v4 scheme (APK Signature Scheme v4): false
Verified for SourceStamp: false
Number of signers: 1
V3.0 Signer: certificate DN: CN=proof
V3.0 Signer: certificate SHA-256 digest: fec53a0c2218898dac7d7ff2e88636cd84cfcba776eeaaa1f0254bd3a1459d68
V3.0 Signer: certificate SHA-1 digest: 66a9292d020f9ef2a2ecffa828a2c6e9317dd9d4
V3.0 Signer: certificate MD5 digest: 70332b3db0a14fd421d937164abb2924
V3.0 Signer: key algorithm: RSA
V3.0 Signer: key size (bits): 2048
V3.0 Signer: public key SHA-256 digest: b78e95de6c80436fbbe99a7563b079b374b0de0922e04b69892c2323a7ed6293
V3.0 Signer: public key SHA-1 digest: 4862a58a4e1ca1380b418b96c3076a90483fe03e
V3.0 Signer: public key MD5 digest: 0ca6e5d526877c2fcc729613d799c977
`;
const PROOF =
  'fec53a0c2218898dac7d7ff2e88636cd84cfcba776eeaaa1f0254bd3a1459d68';
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
    expect(signerDigests(REAL_VERBOSE)).toEqual([PROOF]);
    expect(signerDigests(v2v3(PINNED))).toEqual([PINNED, PINNED]);
    expect(
      signerDigests(
        `Signer #1 certificate SHA-256 digest: ${PINNED}\nSigner (minSdkVersion=24, maxSdkVersion=2147483647) certificate SHA-256 digest: ${OTHER}\n`,
      ),
    ).toEqual([PINNED, OTHER]);
  });

  it('accepts the pinned signer', () => {
    expect(() => checkSigner(REAL_V2, `${colonUpper(PINNED)}\n`)).not.toThrow();
    expect(() => checkSigner(REAL_VERBOSE, colonUpper(PROOF))).not.toThrow();
    // v2 and v3 with the same key are one signer.
    expect(() => checkSigner(v2v3(PINNED), PINNED)).not.toThrow();
  });

  it('rejects a different signer', () => {
    expect(() => checkSigner(REAL_V2, OTHER)).toThrow(PINNED);
    expect(() => checkSigner(REAL_VERBOSE, PINNED)).toThrow(PROOF);
    expect(() => checkSigner(v2v3(OTHER), PINNED)).toThrow(OTHER);
  });

  it('rejects multiple signers', () => {
    expect(() => checkSigner(v2v3(PINNED, 2), PINNED)).toThrow(
      /exactly one signer/,
    );
    expect(() => checkSigner(`${REAL_V2}${v2v3(OTHER)}`, PINNED)).toThrow(
      'found 2 distinct',
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
