import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import {
  type EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { TrnDialogOpenerService } from './dialog/trn-dialog-opener.service';

/**
 * CDK overlay defaults for Trinity.
 *
 * Switches off CDK's `usePopover` mode (Angular 21), which renders overlays in the top layer
 * above every `position: fixed` element, including the toaster, so every dialog, action sheet
 * and tooltip would draw over the toast meant to sit on top of it.
 *
 * Trinity's own, so `apps/trinity` can configure how *our* overlay stack composes without
 * reaching into the vendored kit. The kit's equivalent `provideSpartanHlm()` in
 * `@trinity/helm/utils` stays untouched so a `@spartan-ng/cli` re-sync has nothing to
 * reconcile, and is not the one the app calls.
 *
 * It also starts {@link TrnDialogOpenerService} with the app, so the press that opens the
 * first dialog is already seen.
 */
export function provideTrnOverlayDefaults(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: OVERLAY_DEFAULT_CONFIG,
      useValue: { usePopover: false },
    },
    provideEnvironmentInitializer(() => inject(TrnDialogOpenerService)),
  ]);
}
