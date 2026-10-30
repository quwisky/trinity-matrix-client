import { createHmac } from 'node:crypto';

/** Registers `username` through Synapse's shared-secret admin API. Node only, for tests. */
export async function registerSynapseUser(
  baseUrl: string,
  secret: string,
  username: string,
  admin = false,
): Promise<{ userId: string; accessToken: string; deviceId: string }> {
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
  };
}
