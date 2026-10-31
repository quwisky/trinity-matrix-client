import type { MatrixSession } from '@trinity/util/matrix';
import {
  registerSynapseUser,
  waitForSynapseBackgroundUpdates,
} from '@trinity/testing';

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
  /** Outside the engine, the session's account takes a display name, then creates a room. */
  createNamedRoom(
    session: MatrixSession,
    names: {
      readonly displayName: string;
      readonly roomName: string;
      readonly roomTopic: string;
    },
  ): Promise<void>;
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

  async function asUser(
    session: MatrixSession,
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<void> {
    const res = await fetch(`${baseUrl}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Synapse ${method} ${path} failed: ${res.status}`);
  }

  return {
    waitForBackgroundUpdates: () =>
      waitForSynapseBackgroundUpdates(baseUrl, secret),
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
    async createNamedRoom(session, names) {
      await asUser(
        session,
        'PUT',
        `/profile/${encodeURIComponent(session.userId)}/displayname`,
        { displayname: names.displayName },
      );
      await asUser(session, 'POST', '/createRoom', {
        name: names.roomName,
        topic: names.roomTopic,
        preset: 'private_chat',
      });
    },
  };
}
