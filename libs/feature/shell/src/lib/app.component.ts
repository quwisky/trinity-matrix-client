import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Location } from '@angular/common';
import { Router, RouterOutlet } from '@angular/router';
import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { SwUpdate, type VersionReadyEvent } from '@angular/service-worker';
import { filter, fromEvent } from 'rxjs';
import { getTrinityDesktopBridge } from '@trinity/platform-native';
import { HlmToaster } from '@trinity/helm/sonner';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
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
  private readonly dialog = inject(TrnDialogService);
  private readonly toast = inject(TrnToastService);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    // Recover from a broken service-worker cache (e.g. storage eviction left an
    // asset un-cacheable) by reloading — web-only, no-op when the SW is disabled.
    if (this.swUpdate.isEnabled) {
      this.swUpdate.unrecoverable
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => window.location.reload());
      this.watchForUpdates();
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
    // the whole chain: dismiss the topmost overlay first, then step back through
    // history, and only minimize when there's nowhere left to go. iOS has no hardware
    // back button, so this never fires there.
    //
    // `hasOpen()` spans dialogs, alerts and action sheets alike — they share one overlay
    // stack — and it, not `closeTopmost()`'s return, is what gates navigation. The two
    // answer different questions: "is something on screen" versus "did something close".
    // A dialog can legitimately refuse to close (`disableClose`, or a `closePredicate`),
    // and navigating on that refusal would step the router backwards UNDERNEATH a modal
    // the user can still see — or minimize the app out from under it. So an open overlay
    // always consumes the press, whether or not it was dismissible; that is what Android
    // does for a modal, and it is why the flow-critical encryption dialogs can set
    // `disableClose` and have it mean something.
    void App.addListener('backButton', ({ canGoBack }) => {
      if (this.dialog.hasOpen()) {
        this.dialog.closeTopmost();
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
   * ngsw is version-locked per client: once a tab is running it keeps serving the build
   * it booted with until something activates the new one. Trinity's tabs live for days
   * or weeks, so without this a shipped crypto or session fix never reaches the clients
   * that use the app most. Offer the reload rather than forcing it — reloading under a
   * half-typed message or an in-flight verification would be worse than waiting.
   */
  private watchForUpdates(): void {
    this.swUpdate.versionUpdates
      .pipe(
        filter(
          (event): event is VersionReadyEvent => event.type === 'VERSION_READY',
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        // `duration: 0` is the service's "keep until dismissed" — an update prompt on
        // a timer is one the user loses by looking away.
        this.toast.show('A new version of Trinity is available.', {
          duration: 0,
          action: { label: 'Reload', onClick: () => this.activateUpdate() },
        });
      });

    // ngsw only re-checks the server on its own registration schedule, so a tab left open
    // in a background window can miss a deploy indefinitely. Re-check whenever it comes
    // back to the foreground; VERSION_READY above turns a hit into the prompt.
    fromEvent(document, 'visibilitychange')
      .pipe(
        filter(() => document.visibilityState === 'visible'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        // Offline, or the server is mid-deploy: nothing to do but wait for the next check.
        void this.swUpdate.checkForUpdate().catch(() => undefined);
      });
  }

  /** Swap in the waiting version, then reload onto it. A failed activation still wants
   * the reload: the fresh boot picks up whichever version the SW ends up holding. */
  private activateUpdate(): void {
    void this.swUpdate.activateUpdate().then(
      () => window.location.reload(),
      () => window.location.reload(),
    );
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
