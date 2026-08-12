import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import {
  type EnvironmentProviders,
  makeEnvironmentProviders,
} from '@angular/core';

/**
 * CDK overlay defaults for the kit.
 *
 * The one place #150's prefix substitution produced a worse name than it replaced: applied
 * mechanically it kept the vendor's name — the very thing that rebrand removes — while
 * saying nothing about what the function does. Renamed once, deliberately, and NOT a
 * precedent for renaming anything else in the kit. The codemod stays purely mechanical:
 * this name contains no prefix it maps, so re-running it is still a no-op here.
 *
 * This utility configures the Angular CDK overlay to disable the `usePopover`
 * behavior introduced in Angular 21, which causes CDK overlay-based components
 * (sheets, dialogs, tooltips, etc.) to render above `position: fixed` elements
 * like `<trn-toaster>`.
 *
 * @returns {EnvironmentProviders} Environment providers to be added to the application config.
 *
 * @example
 * ```ts
 * // app.config.ts
 * import { provideKitOverlayDefaults } from '@trinity/kit/utils';
 *
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideKitOverlayDefaults(),
 *     // ... other providers
 *   ],
 * };
 * ```
 */
export function provideKitOverlayDefaults(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: OVERLAY_DEFAULT_CONFIG,
      useValue: { usePopover: false },
    },
  ]);
}
