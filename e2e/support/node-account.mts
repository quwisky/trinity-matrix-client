import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readSession } from './session.mts';
import type { MatrixTestResources } from './test-resources.mts';
import { REGISTRATION_SHARED_SECRET, SYNAPSE_HTTP } from './synapse/start.mjs';

/** Register a unique account only in the invocation-owned disposable Synapse. */
export async function createNodeAccount(
  resources: MatrixTestResources,
  signal?: AbortSignal,
): Promise<{
  readonly username: string;
  readonly password: string;
  readonly homeserver: string;
}> {
  const session = readSession();
  assert(
    session.synapse?.available,
    'This journey requires disposable Synapse',
  );
  const username = resources.userLocalpart('primary');
  const password = randomUUID();
  const requestSignal = (): AbortSignal =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
  const challenge = await fetch(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    signal: requestSignal(),
  });
  assert.equal(challenge.status, 200, 'Synapse registration challenge');
  const body: unknown = await challenge.json();
  assert(
    body &&
      typeof body === 'object' &&
      'nonce' in body &&
      typeof body.nonce === 'string',
    'Synapse registration nonce',
  );
  const nonce = body.nonce;
  const mac = createHmac('sha1', REGISTRATION_SHARED_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const response = await fetch(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, username, password, admin: false, mac }),
    signal: requestSignal(),
  });
  assert.equal(response.status, 200, 'Unique journey account registration');
  return { username, password, homeserver: session.synapse.hs! };
}
