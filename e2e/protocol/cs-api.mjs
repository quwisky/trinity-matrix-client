// Client-Server API driver helpers shared by the protocol specs.
import { protocolResponseFailure } from './diagnostics.mts';

export async function apiLogin(hs, user, pass) {
  const res = await fetch(`${hs}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    }),
  });
  if (!res.ok) {
    throw protocolResponseFailure(`login ${user}`, res);
  }
  return res.json(); // { access_token, user_id, … }
}

export async function csPost(hs, token, path, body) {
  const res = await fetch(`${hs}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw protocolResponseFailure(`POST ${path}`, res);
  }
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : {};
}

/** Retry `fn` until it returns a truthy value or the attempt limit is reached. */
export async function poll(fn, { tries = 30, delayMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('poll timed out');
}
