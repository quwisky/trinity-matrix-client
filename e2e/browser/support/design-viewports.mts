import { devices } from '@playwright/test';

const { defaultBrowserType: _desktopBrowser, ...desktopChrome } =
  devices['Desktop Chrome'];
const { defaultBrowserType: _pixelBrowser, ...pixel5 } = devices['Pixel 5'];

/**
 * Canonical viewport and device profiles for redesign evidence.
 *
 * Desktop entries retain Chromium's desktop user agent. Phone entries retain the full
 * Pixel profile so responsive checks exercise a mobile user agent, touch, device scale,
 * and `isMobile` together rather than shrinking a desktop browser.
 */
export const DESIGN_VIEWPORTS = {
  'desktop-wide': {
    ...desktopChrome,
    viewport: { width: 1440, height: 900 },
  },
  'desktop-standard': {
    ...desktopChrome,
    viewport: { width: 1280, height: 720 },
  },
  'desktop-tablet': {
    ...desktopChrome,
    viewport: { width: 1024, height: 768 },
  },
  'desktop-compact': {
    ...desktopChrome,
    viewport: { width: 900, height: 700 },
  },
  'phone-pixel-5': pixel5,
  'phone-small': {
    ...pixel5,
    screen: { width: 320, height: 568 },
    viewport: { width: 320, height: 568 },
  },
} as const;

export type DesignViewportName = keyof typeof DESIGN_VIEWPORTS;

export const DESIGN_REFERENCE_VIEWPORTS = [
  'desktop-wide',
  'phone-pixel-5',
] as const satisfies readonly DesignViewportName[];
