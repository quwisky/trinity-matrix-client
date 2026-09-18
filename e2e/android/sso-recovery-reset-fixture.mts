import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { waitForNativeShellState } from './native-shell-client.mts';

export interface SsoResetIdentity {
  readonly user: string;
  readonly email: string;
  readonly pass: string;
}

export interface SsoApiSession {
  readonly userId: string;
  readonly accessToken: string;
  readonly loginToken: string;
}

export interface SsoRecoveryState {
  readonly masterKey: string;
  readonly backupVersion: string;
}

interface OpenSsoApiSessionOptions {
  readonly homeserver: string;
  readonly applicationOrigin: string;
  readonly identity: SsoResetIdentity;
  readonly signal: AbortSignal;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as unknown;
  assert(body && typeof body === 'object' && !Array.isArray(body));
  return body as Record<string, unknown>;
}

async function expectOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`${operation} failed with HTTP ${response.status}`);
}

async function captureLoginToken({
  homeserver,
  applicationOrigin,
  identity,
  signal,
}: OpenSsoApiSessionOptions): Promise<string> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let operationFailure: unknown;
  let token: string | undefined;
  try {
    const executablePath = process.env['TRINITY_CHROME_BINARY'];
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--host-resolver-rules=MAP localhost 127.0.0.1'],
    });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const captured: { token: string | null } = { token: null };
    page.on('request', (request) => {
      const match = /[?&]loginToken=([^&]+)/u.exec(request.url());
      if (match?.[1]) captured.token = decodeURIComponent(match[1]);
    });
    const redirectUrl = encodeURIComponent(
      new URL('/sso-harness-callback', applicationOrigin).href,
    );
    await page.goto(
      `${homeserver}/_matrix/client/v3/login/sso/redirect?redirectUrl=${redirectUrl}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.locator('#login').fill(identity.email);
    await page.locator('#password').fill(identity.pass);
    await page.locator('#submit-login').click();
    const observedToken = await waitForNativeShellState(
      async () => captured.token,
      (value): value is string => typeof value === 'string' && value.length > 0,
      'dedicated recovery-reset SSO login token',
      AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      60_000,
    );
    assert(observedToken, 'Dedicated recovery-reset SSO token is non-empty');
    token = observedToken;
  } catch (error) {
    operationFailure = error;
  } finally {
    const failures: unknown[] = [];
    try {
      await context?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
    if (operationFailure !== undefined) failures.unshift(operationFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Dedicated recovery-reset SSO token fixture failed',
      );
    }
  }
  assert(token, 'Dedicated recovery-reset SSO token is non-empty');
  return token;
}

export async function openSsoApiSession(
  options: OpenSsoApiSessionOptions,
): Promise<SsoApiSession> {
  const loginToken = await captureLoginToken(options);
  const response = await fetch(`${options.homeserver}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.token', token: loginToken }),
    signal: requestSignal(options.signal),
  });
  await expectOk(response, 'SSO token redemption');
  const body = await responseBody(response);
  assert.equal(typeof body['user_id'], 'string');
  assert.equal(typeof body['access_token'], 'string');
  return {
    userId: body['user_id'] as string,
    accessToken: body['access_token'] as string,
    loginToken,
  };
}

function authorization(session: SsoApiSession): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}` };
}

async function masterKey(
  homeserver: string,
  session: SsoApiSession,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(`${homeserver}/_matrix/client/v3/keys/query`, {
    method: 'POST',
    headers: {
      ...authorization(session),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_keys: { [session.userId]: [] } }),
    signal: requestSignal(signal),
  });
  await expectOk(response, 'Cross-signing key query');
  const body = await responseBody(response);
  const masterKeys = body['master_keys'];
  if (!masterKeys || typeof masterKeys !== 'object') return undefined;
  const accountKey = (masterKeys as Record<string, unknown>)[session.userId];
  if (!accountKey || typeof accountKey !== 'object') return undefined;
  const keys = (accountKey as Record<string, unknown>)['keys'];
  if (!keys || typeof keys !== 'object') return undefined;
  return Object.keys(keys)[0];
}

async function backupVersion(
  homeserver: string,
  session: SsoApiSession,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(
    `${homeserver}/_matrix/client/v3/room_keys/version`,
    { headers: authorization(session), signal: requestSignal(signal) },
  );
  if (response.status === 404) return undefined;
  await expectOk(response, 'Key-backup version query');
  const body = await responseBody(response);
  return typeof body['version'] === 'string' ? body['version'] : undefined;
}

async function ensureRecoveryPointer(
  homeserver: string,
  session: SsoApiSession,
  signal?: AbortSignal,
): Promise<void> {
  const endpoint = `${homeserver}/_matrix/client/v3/user/${encodeURIComponent(session.userId)}/account_data/m.secret_storage.default_key`;
  const current = await fetch(endpoint, {
    headers: authorization(session),
    signal: requestSignal(signal),
  });
  if (current.ok) {
    const body = await responseBody(current);
    if (typeof body['key'] === 'string' && body['key'].length > 0) return;
  } else if (current.status !== 404) {
    await expectOk(current, 'Secret-storage recovery pointer query');
  }
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      ...authorization(session),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ key: 'trinity-sso-reset-recovery' }),
    signal: requestSignal(signal),
  });
  await expectOk(response, 'Secret-storage recovery pointer seed');
}

export async function ensureSsoRecoveryState(
  homeserver: string,
  session: SsoApiSession,
  signal?: AbortSignal,
): Promise<SsoRecoveryState> {
  if (!(await masterKey(homeserver, session, signal))) {
    const key = randomBytes(32).toString('base64').replace(/=+$/u, '');
    const response = await fetch(
      `${homeserver}/_matrix/client/v3/keys/device_signing/upload`,
      {
        method: 'POST',
        headers: {
          ...authorization(session),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          master_key: {
            user_id: session.userId,
            usage: ['master'],
            keys: { [`ed25519:${key}`]: key },
          },
        }),
        signal: requestSignal(signal),
      },
    );
    await expectOk(response, 'Cross-signing seed');
  }
  if (!(await backupVersion(homeserver, session, signal))) {
    const response = await fetch(
      `${homeserver}/_matrix/client/v3/room_keys/version`,
      {
        method: 'POST',
        headers: {
          ...authorization(session),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
          auth_data: {
            public_key: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY',
          },
        }),
        signal: requestSignal(signal),
      },
    );
    await expectOk(response, 'Key-backup seed');
  }
  await ensureRecoveryPointer(homeserver, session, signal);
  return readSsoRecoveryState(homeserver, session, signal);
}

export async function readSsoRecoveryState(
  homeserver: string,
  session: SsoApiSession,
  signal?: AbortSignal,
): Promise<SsoRecoveryState> {
  const [observedMasterKey, observedBackupVersion] = await Promise.all([
    masterKey(homeserver, session, signal),
    backupVersion(homeserver, session, signal),
  ]);
  assert(observedMasterKey, 'SSO recovery master key is non-empty');
  assert(observedBackupVersion, 'SSO recovery key-backup version is non-empty');
  return {
    masterKey: observedMasterKey,
    backupVersion: observedBackupVersion,
  };
}

export async function closeSsoApiSession(
  homeserver: string,
  session: SsoApiSession,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${homeserver}/_matrix/client/v3/logout`, {
    method: 'POST',
    headers: authorization(session),
    signal: requestSignal(signal),
  });
  await expectOk(response, 'SSO API session logout');
}
