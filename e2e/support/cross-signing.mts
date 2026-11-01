import type { APIRequestContext } from '@playwright/test';
import {
  DeviceId,
  KeysUploadRequest,
  OlmMachine,
  UserId,
  initAsync,
} from '@matrix-org/matrix-sdk-crypto-wasm';

/**
 * Give `user` a cross-signing identity that no device keeps and no secret storage backs:
 * a throwaway, in-memory crypto machine creates the three keys, uploads only their public
 * halves (`/keys/device_signing/upload`, with password UIA when the server asks), and is
 * dropped. That is what another client leaves behind when it set up cross-signing without
 * recovery and was later signed out — the state in which first-device setup used to
 * replace the identity (MSC4153 brief, gap G3).
 *
 * Never logs the token, password or server bodies; failures carry the status only.
 */
export async function publishIdentityWithoutRecovery(
  request: APIRequestContext,
  hs: string,
  user: string,
  password: string,
): Promise<void> {
  const login = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      initial_device_display_name: 'e2e identity fixture',
    },
  });
  if (!login.ok()) {
    throw new Error(`fixture login failed with status ${login.status()}`);
  }
  const session = (await login.json()) as {
    user_id: string;
    device_id: string;
    access_token: string;
  };
  const headers = { Authorization: `Bearer ${session.access_token}` };

  await initAsync();
  const machine = await OlmMachine.initialize(
    new UserId(session.user_id),
    new DeviceId(session.device_id),
  );
  try {
    const requests = await machine.bootstrapCrossSigning(true);
    const keys = JSON.parse(requests.uploadSigningKeysRequest.body) as Record<
      string,
      unknown
    >;
    const url = `${hs}/_matrix/client/v3/keys/device_signing/upload`;
    let upload = await request.post(url, { headers, data: keys });
    if (upload.status() === 401) {
      const { session: uiaSession } = (await upload.json()) as {
        session?: string;
      };
      upload = await request.post(url, {
        headers,
        data: {
          ...keys,
          auth: {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: session.user_id },
            password,
            ...(uiaSession ? { session: uiaSession } : {}),
          },
        },
      });
    }
    if (!upload.ok()) {
      throw new Error(
        `fixture identity upload failed with status ${upload.status()}`,
      );
    }
  } finally {
    machine.close();
  }
  // The fixture's own device holds nothing worth keeping; sign it out.
  await request.post(`${hs}/_matrix/client/v3/logout`, { headers });
}

/**
 * Sign `user` in on one more device that uploads its keys and is never cross-signed: a session
 * of theirs that nobody verified. It stays signed in for the rest of the test.
 */
export async function addUnsignedSession(
  request: APIRequestContext,
  hs: string,
  user: string,
  password: string,
  name: string,
): Promise<void> {
  const login = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      initial_device_display_name: name,
    },
  });
  if (!login.ok()) {
    throw new Error(`fixture login failed with status ${login.status()}`);
  }
  const session = (await login.json()) as {
    user_id: string;
    device_id: string;
    access_token: string;
  };

  await initAsync();
  const machine = await OlmMachine.initialize(
    new UserId(session.user_id),
    new DeviceId(session.device_id),
  );
  try {
    const outgoing = await machine.outgoingRequests();
    const keys = outgoing.find((r) => r instanceof KeysUploadRequest);
    if (!keys) throw new Error('fixture device has no keys to upload');
    const upload = await request.post(`${hs}/_matrix/client/v3/keys/upload`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
      data: JSON.parse(keys.body) as Record<string, unknown>,
    });
    if (!upload.ok()) {
      throw new Error(
        `fixture key upload failed with status ${upload.status()}`,
      );
    }
  } finally {
    machine.close();
  }
}
