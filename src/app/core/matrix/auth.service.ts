import { Injectable, inject } from '@angular/core';
import { AutoDiscovery, createClient } from 'matrix-js-sdk';
import { MatrixClientService } from './matrix-client.service';
import { SessionStorageService } from '../storage/session-storage.service';
import { MatrixSession } from './session.model';

const DEVICE_DISPLAY_NAME = 'Trinity (Ionic)';

/**
 * Handles authentication: homeserver discovery (.well-known), password login,
 * SSO URL construction, and logout. On success it persists the session and hands
 * the live client to MatrixClientService.
 *
 * Components talk to this service, never to matrix-js-sdk directly.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);

  /**
   * Resolve a homeserver base URL from a user-entered domain (e.g. "matrix.org"
   * or "@me:example.org" -> "example.org") via .well-known auto-discovery.
   * Falls back to https://<domain> when discovery is silent.
   */
  async discoverHomeserver(input: string): Promise<string> {
    const domain = this.extractDomain(input);
    const config = await AutoDiscovery.findClientConfig(domain);
    const hs = config['m.homeserver'];

    if (hs.state === AutoDiscovery.FAIL_PROMPT || hs.state === AutoDiscovery.FAIL_ERROR) {
      const reason = typeof hs.error === 'string' ? hs.error : null;
      throw new Error(reason ?? `Could not discover a homeserver for "${domain}".`);
    }
    const baseUrl = hs.base_url ?? `https://${domain}`;
    return baseUrl.replace(/\/$/, '');
  }

  /** Which login flows the homeserver supports (e.g. 'm.login.password', 'm.login.sso'). */
  async getSupportedFlows(baseUrl: string): Promise<string[]> {
    const tmp = createClient({ baseUrl });
    const res = await tmp.loginFlows();
    return res.flows.map((f) => f.type);
  }

  /** Log in with username + password, persist the session, and start the client. */
  async loginWithPassword(baseUrl: string, user: string, password: string): Promise<void> {
    const tmp = createClient({ baseUrl });
    const res = await tmp.login('m.login.password', {
      identifier: { type: 'm.id.user', user: this.localpart(user) },
      password,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
    });

    const session: MatrixSession = {
      baseUrl,
      userId: res.user_id,
      deviceId: res.device_id,
      accessToken: res.access_token,
    };

    await this.storage.save(session);
    await this.matrix.init(session);
  }

  /** Build the SSO redirect URL the browser/WebView should navigate to. */
  getSsoUrl(baseUrl: string, redirectUrl: string): string {
    return createClient({ baseUrl }).getSsoLoginUrl(redirectUrl, 'sso');
  }

  /**
   * Complete an SSO/CAS login by exchanging the returned `loginToken` for a session.
   * Called from the SSO callback route after the homeserver redirects back.
   */
  async completeSsoLogin(baseUrl: string, loginToken: string): Promise<void> {
    const tmp = createClient({ baseUrl });
    const res = await tmp.login('m.login.token', {
      token: loginToken,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
    });

    const session: MatrixSession = {
      baseUrl,
      userId: res.user_id,
      deviceId: res.device_id,
      accessToken: res.access_token,
    };

    await this.storage.save(session);
    await this.matrix.init(session);
  }

  /** Invalidate the server-side device, stop the client, and clear local state. */
  async logout(): Promise<void> {
    if (this.matrix.isInitialized) {
      try {
        await this.matrix.instance.logout(true);
      } catch {
        // Even if the server call fails, clear locally so the user isn't stuck.
      }
    }
    await this.matrix.stop();
    await this.storage.clear();
  }

  /** Accept "@user:server.org", "user:server.org", or a bare "server.org". */
  private extractDomain(input: string): string {
    const trimmed = input.trim().replace(/^@/, '');
    const colon = trimmed.indexOf(':');
    return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  }

  /** Strip a full MXID down to its localpart for the password identifier. */
  private localpart(user: string): string {
    const trimmed = user.trim().replace(/^@/, '');
    const colon = trimmed.indexOf(':');
    return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
  }
}
