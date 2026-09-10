import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  readAndroidSurface,
  waitForAndroidAccount,
  waitForAndroidState,
} from '../e2e/android/critical-client.mts';

describe('Critical Android process readiness', () => {
  it('observes a loading WebView before its document body exists', async () => {
    const surface = await readAndroidSurface({
      pid: '4321',
      diagnostics: {
        async send(_method, { expression }) {
          return {
            result: {
              value: runInNewContext(expression, {
                location: { href: 'https://localhost/' },
                document: {
                  body: null,
                  visibilityState: 'visible',
                  querySelector: () => null,
                  querySelectorAll: () => [],
                },
              }),
            },
          };
        },
      },
    });
    expect(surface).toEqual({
      url: 'https://localhost/',
      body: '',
      visibility: 'visible',
      composer: null,
      messages: [],
    });
  });

  it('reads the persisted cryptoPrefix without exposing other registry fields', async () => {
    const account = {
      userId: '@alice:localhost',
      deviceId: 'DEVICE',
      cryptoPrefix: 'trinity-crypto:@alice:localhost:DEVICE',
    };
    const registry = JSON.stringify({
      activeUserId: account.userId,
      accounts: [{ ...account, baseUrl: 'https://localhost:8448' }],
    }).replaceAll('"', '&quot;');
    const device = {
      adb: async () =>
        `<map><string name="matrix.accounts">${registry}</string></map>`,
    };
    await expect(
      waitForAndroidAccount(
        device,
        'eu.qwky.trinity',
        account.userId,
        AbortSignal.timeout(1_000),
      ),
    ).resolves.toEqual(account);
  });
});
