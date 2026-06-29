import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { SwUpdate } from '@angular/service-worker';
import { IonApp, IonRouterOutlet, Platform } from '@ionic/angular/standalone';
import { getTrinityDesktopBridge } from '@trinity/core';
import { VerificationHostComponent } from './verification-host.component';

@Component({
  selector: 'trn-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'app.component.html',
  imports: [IonApp, IonRouterOutlet, VerificationHostComponent],
})
export class AppComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly swUpdate = inject(SwUpdate);
  private readonly platform = inject(Platform);

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
    // Android hardware back: IonRouterOutlet (higher priority) pops overlays/routes
    // first; this lowest-priority handler runs only when nothing was left to pop (the
    // root), where it backgrounds the app rather than letting the JS-suppressed default
    // do nothing. iOS has no hardware back, so this never fires there.
    this.platform.backButton.subscribeWithPriority(-1, () => {
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
   * Route an `eu.qwky.trinity://sso-callback?loginToken=…&sso_state=…` deep link
   * into the SSO callback page (the homeserver redirects here after native SSO).
   */
  handleDeepLink(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const path = parsed.host || parsed.pathname.replace(/^\/+/, '');
    const loginToken = parsed.searchParams.get('loginToken');
    if (path !== 'sso-callback' || !loginToken) {
      return;
    }
    // Dismiss the system browser opened for SSO, then hand off to the callback.
    void Browser.close().catch(() => undefined);
    void this.router.navigate(['/sso-callback'], {
      queryParams: {
        loginToken,
        sso_state: parsed.searchParams.get('sso_state'),
      },
    });
  }
}
