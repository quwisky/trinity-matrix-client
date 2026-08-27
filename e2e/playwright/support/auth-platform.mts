import type { Page } from '@playwright/test';

export type AuthRouteMatcher = Parameters<Page['route']>[0];
export type AuthRouteHandler = Parameters<Page['route']>[1];
export type AuthCallbackKind = 'oidc' | 'sso';

export interface ExternalPageLease {
  page: Page;
  close(): Promise<void>;
}

/**
 * The platform boundary around an authentication browser hand-off.
 *
 * Web navigates the app tab itself. Android keeps the installed app's WebView alive,
 * opens a Chrome Custom Tab through Capacitor Browser, and returns through an OS deep
 * link. Canonical specs use this adapter so requesting Android coverage can never
 * silently launch Playwright's desktop Chromium fixture.
 */
export interface AuthPlatform {
  readonly isNative: boolean;
  readonly oidcApplicationType: 'native' | 'web';

  route(
    appPage: Page,
    matcher: AuthRouteMatcher,
    handler: AuthRouteHandler,
  ): Promise<void>;

  waitForExternalPage(
    appPage: Page,
    trigger: () => Promise<unknown>,
  ): Promise<Page>;

  openIsolatedPage(): Promise<ExternalPageLease>;

  callbackUrl(
    appPage: Page,
    callbackPath: string,
    kind: AuthCallbackKind,
  ): string;

  navigateCallback(
    appPage: Page,
    callbackPath: string,
    kind: AuthCallbackKind,
  ): Promise<void>;
}
