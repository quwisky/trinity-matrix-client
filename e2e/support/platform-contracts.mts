import type { Locator, Page } from '@playwright/test';

export type Navigate = (page: Page, path: string) => Promise<void>;
export type AuthRouteMatcher = Parameters<Page['route']>[0];
export type AuthRouteHandler = Parameters<Page['route']>[1];
export type AuthCallbackKind = 'oidc' | 'sso';

export interface ExternalPageLease {
  readonly page: Page;
  close(): Promise<void>;
}

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

export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

export interface TouchPlatform {
  /** Dismiss an installed host keyboard; browser device profiles have no native IME. */
  dismissKeyboard(page: Page): Promise<void>;
  tap(page: Page, target: Locator): Promise<void>;
  swipe(page: Page, from: TouchPoint, to: TouchPoint): Promise<void>;
}
