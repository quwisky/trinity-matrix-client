import { createHmac, randomUUID } from 'node:crypto';

/** Registers `username` through Synapse's shared-secret admin API. Node only, for tests. */
export async function registerSynapseUser(
  baseUrl: string,
  secret: string,
  username: string,
  admin = false,
): Promise<{
  userId: string;
  accessToken: string;
  deviceId: string;
  password: string;
}> {
  const api = `${baseUrl}/_synapse/admin/v1/register`;
  const nonceRes = await fetch(api);
  if (!nonceRes.ok)
    throw new Error(`Synapse nonce request failed: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const mac = createHmac('sha1', secret)
    .update(
      `${nonce}\0${username}\0${password}\0${admin ? 'admin' : 'notadmin'}`,
    )
    .digest('hex');
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({ nonce, username, password, mac, admin }),
  });
  if (!res.ok) throw new Error(`Synapse registration failed: ${res.status}`);
  const body = (await res.json()) as {
    user_id: string;
    access_token: string;
    device_id: string;
  };
  return {
    userId: body.user_id,
    accessToken: body.access_token,
    deviceId: body.device_id,
    password,
  };
}

/** Waits until a fresh Synapse has finished the background updates that drop users registered meanwhile. Node only, for tests. */
export async function waitForSynapseBackgroundUpdates(
  baseUrl: string,
  secret: string,
): Promise<void> {
  const admin = await registerSynapseUser(
    baseUrl,
    secret,
    `admin-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    true,
  );
  for (let i = 0; i < 240; i++) {
    const res = await fetch(
      `${baseUrl}/_synapse/admin/v1/background_updates/status`,
      { headers: { authorization: `Bearer ${admin.accessToken}` } },
    );
    if (!res.ok)
      throw new Error(`Synapse background update status failed: ${res.status}`);
    const { current_updates } = (await res.json()) as {
      current_updates: Record<string, unknown>;
    };
    if (Object.keys(current_updates).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Synapse background updates did not finish');
}

/** A Client-Server API call (`/_matrix/client/v3` + `path`) as `accessToken`, over plain HTTP; throws on a non-2xx answer. */
export async function synapseRequest<T>(
  baseUrl: string,
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl}/_matrix/client/v3${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}
