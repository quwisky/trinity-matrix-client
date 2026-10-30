import type { MatrixSession } from '@trinity/util/matrix';
import { registerSynapseUser } from '@trinity/testing';

/**
 * The live-Synapse side of the session contract, over plain HTTP so any engine can use it.
 * Its members need no `this`, so a setup can pass them on as they are.
 */
export function sessionSynapseFixture(
  baseUrl: string,
  secret: string,
): {
  /** Waits until a fresh Synapse no longer drops users registered meanwhile. */
  waitForBackgroundUpdates(): Promise<void>;
  /** A password session with its own device; no refresh token or lifetime is requested. */
  newSession(): Promise<MatrixSession>;
  tokenAccepted(session: MatrixSession): Promise<boolean>;
  revokeToken(session: MatrixSession): Promise<void>;
  passwordFor(session: MatrixSession): string;
  /** Signs in with the account's password as a new device. */
  signInAgain(session: MatrixSession): Promise<MatrixSession>;
} {
  const passwords = new Map<string, string>();
  let sequence = 0;

  async function login(userId: string): Promise<MatrixSession> {
    const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: userId },
        password: passwords.get(userId),
      }),
    });
    if (!res.ok) throw new Error(`Synapse login failed: ${res.status}`);
    const body = (await res.json()) as {
      user_id: string;
      device_id: string;
      access_token: string;
    };
    return {
      baseUrl,
      userId: body.user_id,
      deviceId: body.device_id,
      accessToken: body.access_token,
    };
  }

  return {
    // A fresh Synapse rebuilds its user directory in a background update and drops users
    // registered meanwhile, so the contract users are only created once it has finished.
    async waitForBackgroundUpdates() {
      const admin = await registerSynapseUser(
        baseUrl,
        secret,
        `admin-${Date.now().toString(36)}`,
        true,
      );
      for (let i = 0; i < 240; i++) {
        const res = await fetch(
          `${baseUrl}/_synapse/admin/v1/background_updates/status`,
          { headers: { authorization: `Bearer ${admin.accessToken}` } },
        );
        if (!res.ok)
          throw new Error(
            `Synapse background update status failed: ${res.status}`,
          );
        const { current_updates } = (await res.json()) as {
          current_updates: Record<string, unknown>;
        };
        if (Object.keys(current_updates).length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('Synapse background updates did not finish');
    },
    async newSession() {
      sequence += 1;
      const user = await registerSynapseUser(
        baseUrl,
        secret,
        `sess-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`,
      );
      passwords.set(user.userId, user.password);
      return login(user.userId);
    },
    async tokenAccepted(session) {
      const res = await fetch(`${baseUrl}/_matrix/client/v3/account/whoami`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      if (res.ok) return true;
      const body = (await res.json().catch(() => ({}))) as {
        errcode?: string;
      };
      if (res.status === 401 || body.errcode === 'M_UNKNOWN_TOKEN')
        return false;
      throw new Error(`Synapse whoami failed: ${res.status}`);
    },
    async revokeToken(session) {
      const res = await fetch(`${baseUrl}/_matrix/client/v3/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      if (!res.ok) throw new Error(`Synapse logout failed: ${res.status}`);
    },
    passwordFor: (session) => passwords.get(session.userId) ?? '',
    signInAgain: (session) => login(session.userId),
  };
}
