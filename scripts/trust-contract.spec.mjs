import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  workspaceRoot,
  read as source,
  sourcesWithHarnesses,
  productionSources,
} from './workspace-sources.mjs';

/** Freeze #319's Trust expand-contract migration. */
describe('Trust production boundary', () => {
  it('owns verification and recovery through one capability entrypoint', () => {
    const entrypoint = source('libs/data-access/trust/src/index.ts');
    const paths = source('tsconfig.base.json');

    for (const module of [
      'trust.service',
      'trust-lifetime',
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

  it('reaches Matrix only through its engine', () => {
    // The Trust spec harness mocks MatrixClientService; only production code is frozen.
    const trust = productionSources
      .filter((file) => file.startsWith('libs/data-access/trust/'))
      .map(source)
      .join('\n');

    expect(trust).toContain('TRUST_ENGINE');
    expect(trust).not.toContain('TrustCryptoPort');
    expect(trust).not.toContain('MatrixClientService');
    expect(trust).not.toContain('initRustCrypto');
    expect(
      existsSync(
        join(
          workspaceRoot,
          'libs/data-access/matrix-client/src/lib/trust-crypto.port.ts',
        ),
      ),
    ).toBe(false);
  });

  it('keeps commands cold and exposes typed recovery meaning', () => {
    const trust = sourcesWithHarnesses
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
    const composition = source(
      'libs/application/runtime/src/lib/composition/application-capability.providers.ts',
    );
    const feature = sourcesWithHarnesses
      .filter((file) => file.startsWith('libs/feature/crypto/'))
      .map(source)
      .join('\n');

    expect(composition).toContain('provide: TRUST_PROVIDER_RECOVERY');
    expect(composition).toContain('inject(AuthService)');
    expect(feature).not.toContain("from '@trinity/data-access/auth'");
  });

  it('keeps session projections inside the named Trust lifetime', () => {
    const lifetime = source('libs/data-access/trust/src/lib/trust-lifetime.ts');
    const session = source(
      'libs/application/runtime/src/lib/composition/trinity-application-session.adapter.ts',
    );

    expect(lifetime).toContain('class TrustLifetime');
    expect(lifetime).toContain("capability: 'trust'");
    expect(lifetime).toContain("'not-applicable'");
    expect(lifetime).toContain('this.health.retryProjection()');
    expect(lifetime).toContain('this.verification.retryProjection()');
    expect(session).toContain('inject(TrustLifetime)');
    expect(session).toContain('this.reportHealthForActiveAccount(event.fact');
    expect(session).toContain('this.health.report(fact, recovery)');
  });

  it('separates current Trust state from explicitly stale last-known data', () => {
    const health = source(
      'libs/data-access/trust/src/lib/trust-health.service.ts',
    );

    expect(health).toContain("readonly availability: 'coherent'");
    expect(health).toContain("readonly availability: 'stale'");
    expect(health).toContain("readonly availability: 'unavailable'");
    expect(health).toContain('readonly current: null');
    expect(health).toContain('readonly stale: TrustHealthSnapshot');
  });
});
