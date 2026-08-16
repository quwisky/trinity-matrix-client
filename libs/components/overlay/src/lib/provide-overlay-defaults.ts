import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import {
  type EnvironmentProviders,
  makeEnvironmentProviders,
} from '@angular/core';

/**
 * CDK overlay defaults for Trinity.
 *
 * Angular 21 gave CDK overlays a `usePopover` mode, which renders them in the top layer —
 * above every `position: fixed` element, including the toaster. Every dialog, action sheet
 * and tooltip in the app then draws over the toast that was meant to sit on top of it, so
 * the mode is switched off here, once, for the whole application.
 *
 * Trinity's own, deliberately: it is a decision about how *our* overlay stack composes, and
 * `apps/trinity` must be able to configure that without reaching into the vendored kit. The
 * generated kit ships an equivalent `provideSpartanHlm()` in `@trinity/helm/utils`; that one
 * stays untouched so a `@spartan-ng/cli` re-sync has nothing to reconcile, and is simply not
 * the one the app calls.
 */
export function provideTrnOverlayDefaults(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: OVERLAY_DEFAULT_CONFIG,
      useValue: { usePopover: false },
    },
  ]);
}
