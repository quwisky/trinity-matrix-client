import {
  devices,
  expect,
  test as webTest,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import type { AuthPlatform } from './support/platform-contracts.mts';
import { resourceFixtureDefinitions } from './support/resource-fixtures.mts';
import { cdpSwipe, type TouchPlatform } from './support/touch-platform.mts';

const webTestWithPlatform = webTest.extend<{
  secondaryApp: {
    launch(): Promise<Page>;
    activatePrimary(): Promise<void>;
  };
  authPlatform: AuthPlatform;
  touchPlatform: TouchPlatform;
}>({
  touchPlatform: async ({}, use) => {
    await use({
      async tap(_page, target): Promise<void> {
        // The browser profile is a layout proxy; reserve real touch dispatch for the
        // installed WebView fixture. Click preserves the browser's stable activation path
        // while native tests use the platform bridge below.
        await target.click({ force: true, timeout: 30_000 });
      },
      async dismissKeyboard(): Promise<void> {
        // Browser device profiles do not display an operating-system keyboard.
      },
      swipe: cdpSwipe,
    });
  },
  secondaryApp: async ({ browser }, use) => {
    let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    try {
      await use({
        async launch(): Promise<Page> {
          context ??= await browser.newContext({ ignoreHTTPSErrors: true });
          return context.pages()[0] ?? context.newPage();
        },
        async activatePrimary(): Promise<void> {
          /* the primary browser page remains foreground-capable */
        },
      });
    } finally {
      await context?.close();
    }
  },

  authPlatform: async ({ browser }, use) => {
    const auxiliaryContexts = new Set<BrowserContext>();
    try {
      await use({
        isNative: false,
        oidcApplicationType: 'web',
        async route(appPage, matcher, handler): Promise<void> {
          await appPage.route(matcher, handler);
        },
        async waitForExternalPage(appPage, trigger): Promise<Page> {
          await trigger();
          return appPage;
        },
        async openIsolatedPage() {
          const context = await browser.newContext({ ignoreHTTPSErrors: true });
          auxiliaryContexts.add(context);
          return {
            page: await context.newPage(),
            async close(): Promise<void> {
              auxiliaryContexts.delete(context);
              await context.close();
            },
          };
        },
        callbackUrl(appPage, callbackPath): string {
          return new URL(callbackPath, appPage.url()).href;
        },
        async navigateCallback(appPage, callbackPath): Promise<void> {
          await appPage.goto(callbackPath, { waitUntil: 'domcontentloaded' });
        },
      });
    } finally {
      await Promise.allSettled(
        [...auxiliaryContexts].map((context) => context.close()),
      );
    }
  },
});

/** Web adapter selected by the aggregate fixture for browser journey runs. */
export const test = webTestWithPlatform.extend(resourceFixtureDefinitions);

export { devices, expect };
export type { APIRequestContext, Locator, Page, Route };
