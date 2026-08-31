import { createHmac } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { REGISTRATION_SHARED_SECRET, SYNAPSE_HTTP } from './synapse/start.mjs';

// The server-side view of a harness account: how to create one, and the three pieces of
// crypto state the recovery-reset specs assert on.
//
// The constants come from e2e/support/synapse/start.mjs rather than being restated here. A local
// copy of the shared secret that drifts from the one start.mjs patches into
// homeserver.yaml does not fail loudly: register_new_matrix_user computes its HMAC with
// one secret while Synapse validates against the other, and all a spec sees is
// `403 M_FORBIDDEN: HMAC incorrect`.

/** An authenticated account, as every helper here needs to see it. */
export interface AccountSession {
  userId: string;
  accessToken: string;
}

const bearer = ({ accessToken }: AccountSession): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
});

/**
 * Register a throwaway account through Synapse's shared-secret admin API.
 *
 * The harness has a registration routine of its own (`registerUser` in
 * e2e/support/synapse/start.mjs) but it is not reusable from a spec: it shells into the Synapse
 * container with `docker compose exec`, which needs the compose context the harness owns.
 * The secret both sign with is the part that must not be duplicated, and is imported.
 *
 * Tolerates an account that already exists, so a Playwright retry can reuse whatever the
 * previous attempt registered.
 */
export async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REGISTRATION_SHARED_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

/** Log in over the CS API, for the assertions a spec has to make as the server sees them. */
export async function passwordLogin(
  request: APIRequestContext,
  hs: string,
  username: string,
  password: string,
): Promise<AccountSession> {
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
    },
  });
  if (!res.ok()) {
    throw new Error(`login ${username} → ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return {
    userId: body.user_id as string,
    accessToken: body.access_token as string,
  };
}

/**
 * The account's 4S default-key pointer, or undefined when it has no usable recovery key.
 *
 * The only place a completed reset is observable from outside the device that ran it: the
 * device keeps its cross-signing keys either way, so its own status reads `ready` whether
 * or not secret storage was rebuilt.
 */
export async function defaultKeyId(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
): Promise<string | undefined> {
  const res = await request.get(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(account.userId)}/account_data/m.secret_storage.default_key`,
    { headers: bearer(account) },
  );
  return res.ok() ? ((await res.json()).key as string) : undefined;
}

/** The account's current key-backup version, or undefined when it has none. */
export async function keyBackupVersion(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
): Promise<string | undefined> {
  const res = await request.get(`${hs}/_matrix/client/v3/room_keys/version`, {
    headers: bearer(account),
  });
  return res.ok() ? ((await res.json()).version as string) : undefined;
}

/** The account's cross-signing master key as the homeserver holds it. */
export async function masterKey(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
): Promise<string | undefined> {
  const res = await request.post(`${hs}/_matrix/client/v3/keys/query`, {
    headers: bearer(account),
    data: { device_keys: { [account.userId]: [] } },
  });
  const keys = (await res.json()).master_keys?.[account.userId]?.keys;
  return keys ? Object.keys(keys)[0] : undefined;
}
