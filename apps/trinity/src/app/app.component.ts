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
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { VerificationHostComponent } from './verification-host.component';

@Component({
  selector: 'trn-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'app.component.html',
  imports: [IonApp, IonRouterOutlet, VerificationHostComponent],
})
export class AppComponent implements OnInit {
  private readonly router = inject(Router);

  ngOnInit(): void {
    // Deep links only arrive on native; the web SSO flow uses the /sso-callback
    // route directly. Listen for warm opens and handle a cold-start launch URL.
    if (!Capacitor.isNativePlatform()) {
      return;
    }
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
