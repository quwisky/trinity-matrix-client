import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
} from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { Location } from '@angular/common';
import { Router, RouterOutlet } from '@angular/router';
import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { SwUpdate } from '@angular/service-worker';
import { getTrinityDesktopBridge } from '@trinity/platform-native';
import { HlmToaster } from '@trinity/helm/sonner';
import { VerificationHostComponent } from './verification-host.component';

@Component({
  selector: 'trn-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'app.component.html',
  imports: [RouterOutlet, VerificationHostComponent, HlmToaster],
})
export class AppComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly swUpdate = inject(SwUpdate);
  private readonly dialog = inject(Dialog);
  private readonly location = inject(Location);

  ngOnInit(): void {
    // Recover from a broken service-worker cache (e.g. storage eviction left an
    // asset un-cacheable) by reloading — web-only, no-op when the SW is disabled.
    if (this.swUpdate.isEnabled) {
      this.swUpdate.unrecoverable.subscribe(() => window.location.reload());
    }

    // Electron desktop: the main process forwards `eu.qwky.trinity://` deep links
    // (e.g. the SSO callback) over the preload bridge — there's no Capacitor App
    // plugin in the hand-rolled shell.
    const desktop = getTrinityDesktopBridge();
    if (desktop?.onDeepLink) {
      desktop.onDeepLink((url) => this.handleDeepLink(url));
    }

    // Native deep links arrive via Capacitor App; the web SSO flow uses the
    // /sso-callback route directly. Listen for warm opens + a cold-start URL.
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    // Android hardware back button. IonRouterOutlet used to intercept this at a
    // higher priority to pop overlays/routes, leaving the lowest-priority handler to
    // only background the app at the root. With a plain Angular router-outlet we own
    // the whole chain: dismiss the top open CDK overlay (TrnDialog/TrnAlert/ActionSheet
    // all render through @angular/cdk/dialog) first, then step back through history,
    // and only minimize when there's nowhere left to go. iOS has no hardware back
    // button, so this never fires there.
    void App.addListener('backButton', ({ canGoBack }) => {
      const overlays = this.dialog.openDialogs;
      if (overlays.length > 0) {
        overlays[overlays.length - 1].close();
        return;
      }
      if (canGoBack) {
        this.location.back();
        return;
      }
      void App.minimizeApp();
    });
    void App.addListener('appUrlOpen', (event: URLOpenListenerEvent) =>
      this.handleDeepLink(event.url),
    );
    void App.getLaunchUrl().then((launch) => {
      if (launch?.url) {
        this.handleDeepLink(launch.url);
      }
    });
  }

  /**
   * Route a `eu.qwky.trinity://sso-callback?…` deep link into the callback page. Both
   * login flows land here (the provider/homeserver redirects back after native auth):
   * legacy SSO carries `loginToken` (+ `sso_state`), OIDC carries `code` + `state` (or
   * an `error`). Only the params that are present are forwarded, so the callback page
   * branches on which flow arrived.
   */
  handleDeepLink(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const path = parsed.host || parsed.pathname.replace(/^\/+/, '');
    const params = parsed.searchParams;
    const isCallback =
      path === 'sso-callback' &&
      (params.has('loginToken') || params.has('code') || params.has('error'));
    if (!isCallback) {
      return;
    }
    // Dismiss the system browser opened for auth, then hand off to the callback.
    void Browser.close().catch(() => undefined);
    const queryParams: Record<string, string> = {};
    for (const key of CALLBACK_PARAMS) {
      const value = params.get(key);
      if (value !== null) {
        queryParams[key] = value;
      }
    }
    void this.router.navigate(['/sso-callback'], { queryParams });
  }
}

/** Callback params forwarded from a deep link (SSO + OIDC); absent ones are omitted. */
const CALLBACK_PARAMS = [
  'loginToken',
  'sso_state',
  'code',
  'state',
  'error',
  'error_description',
] as const;
