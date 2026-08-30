import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();

/** Freeze #319's Trust expand-contract migration. */
describe('Trust production boundary', () => {
  it('owns verification and recovery through one capability entrypoint', () => {
    const entrypoint = source('libs/data-access/trust/src/index.ts');
    const paths = source('tsconfig.base.json');

    for (const module of [
      'trust.service',
      'trust-verification.service',
      'trust-devices.service',
      'trust-operation-error',
    ]) {
      expect(entrypoint).toContain(`export * from './lib/${module}'`);
    }
    expect(paths).toContain('"@trinity/data-access/trust"');
    expect(paths).not.toContain('"@trinity/data-access/crypto"');
    expect(existsSync(join(workspaceRoot, 'libs/data-access/crypto'))).toBe(
      false,
    );
  });

  it('depends on a lifecycle-free Matrix crypto port', () => {
    const trust = productionSources
      .filter((file) => file.startsWith('libs/data-access/trust/'))
      .map(source)
      .join('\n');
    const port = source(
      'libs/data-access/matrix-client/src/lib/trust-crypto.port.ts',
    );
    const activeView = port.match(
      /export interface ActiveTrustCrypto \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;
    const clientView = port.match(
      /export type TrustMatrixClient = Pick<(?<body>[\s\S]*?)>;\n/,
    )?.groups?.body;
    const projectionConfig = port.match(
      /export interface TrustCryptoProjectionConfig \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(trust).toContain('TrustCryptoPort');
    expect(trust).not.toContain('MatrixClientService');
    expect(trust).not.toContain('initRustCrypto');
    expect(port).not.toMatch(
      /\b(?:addAccount|removeAccount|switchAccount|startClient|stopClient|initRustCrypto)\b\s*\(/,
    );
    expect(activeView).toBeDefined();
    expect(activeView).not.toMatch(/\b(?:MatrixClient|CryptoApi)\b/);
    expect(clientView).toBeDefined();
    expect(clientView).not.toMatch(
      /\b(?:addAccount|removeAccount|switchAccount|startClient|stopClient|initRustCrypto)\b/,
    );
    expect(projectionConfig).toBeDefined();
    expect(projectionConfig).not.toMatch(
      /\b(?:MatrixClient|CryptoApi|ProjectFromClientConfig)\b/,
    );
    expect(
      existsSync(
        join(
          workspaceRoot,
          'libs/data-access/matrix-client/src/lib/crypto-spike.service.ts',
        ),
      ),
    ).toBe(true);
  });

  it('keeps commands cold and exposes typed recovery meaning', () => {
    const trust = productionSources
      .filter((file) => file.startsWith('libs/data-access/trust/'))
      .map(source)
      .join('\n');

    expect(trust).toContain('return defer(() =>');
    expect(trust).toContain("| 'provider-action-required'");
    expect(trust).toContain("| 'partial-update'");
    expect(trust).toContain("| 'review-security-settings'");
    expect(trust).not.toMatch(
      /\basync\s+(?:setUp|resetRecovery|recoverWithKey|recoverWithPassphrase|exportRoomKeys|importRoomKeys|list|rename|delete|startSelfVerification|startUserVerification|accept|startSas|showQr|scanQr|confirmQr|confirmSas|cancel)\s*\(/,
    );
  });

  it('never retains QR bytes or raw SDK errors in public Trust state', () => {
    const verification = source(
      'libs/data-access/trust/src/lib/trust-verification.service.ts',
    );
    const view = verification.match(
      /export interface VerificationView \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;
    const failure = source(
      'libs/data-access/trust/src/lib/trust-operation-error.ts',
    );

    expect(view).toBeDefined();
    expect(view).not.toContain('Uint8ClampedArray');
    expect(view).not.toContain('qrCodeData');
    expect(failure).not.toMatch(/readonly\s+cause\b/);
    expect(failure).not.toMatch(/this\.cause\s*=/);
  });

  it('composes provider recovery at the app root, outside Trust screens', () => {
    const main = source('apps/trinity/src/main.ts');
    const feature = productionSources
      .filter((file) => file.startsWith('libs/feature/crypto/'))
      .map(source)
      .join('\n');

    expect(main).toContain('provide: TRUST_PROVIDER_RECOVERY');
    expect(main).toContain('inject(AuthService)');
    expect(feature).not.toContain("from '@trinity/data-access/auth'");
  });
});
