import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const CLIENT_ID = 'trinity-native-refresh-e2e';
// Dex takes any http://localhost redirect from a public client; nothing ever listens on it.
const REDIRECT_URI = 'http://localhost/callback';
const STDERR_TAIL_CHARS = 2_000;

export interface DexTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Dex's answer to a refresh grant. Holds tokens: never print it. */
export interface DexRefreshAnswer {
  readonly status: number;
  readonly error?: string;
  readonly tokens?: DexTokens;
}

export interface OwnDex {
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenEndpoint: string;
  /** A fresh token pair for Dex's mock identity, by an authorization-code exchange. */
  mint(): Promise<DexTokens>;
  refresh(refreshToken: string): Promise<DexRefreshAnswer>;
  stop(): void;
}

/** False only for a missing binary: a `dex` that is there but broken should fail, not skip. */
export function dexOnPath(): Promise<boolean> {
  return promisify(execFile)('dex', ['version']).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
  );
}

/** A loopback port nothing listens on once this returns. */
export function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('the probe socket has no port')),
      );
    });
  });
}

/**
 * A Dex of this spec's own rather than the stack's. Dex 2.46.1 (dexidp/dex#5017) reads the offline
 * session inside the refresh token's update, which deadlocks memory storage on a second refresh
 * and then hangs every later request, so a real grant on the shared Dex would wedge the SSO specs.
 * DEX_SESSIONS_ENABLED takes the identity from elsewhere and skips that read, and the sessions it
 * adds are not something the other suites should run on.
 * shortcut: a private process with an experimental flag; drop both once the stack's Dex has the fix.
 */
export async function startOwnDex(): Promise<OwnDex> {
  const port = await unusedPort();
  const issuer = `http://localhost:${port}/dex`;
  const directory = mkdtempSync(join(tmpdir(), 'trinity-own-dex-'));
  const configFile = join(directory, 'dex.json');
  writeFileSync(
    configFile,
    // JSON is YAML, which is what Dex reads.
    JSON.stringify({
      issuer,
      storage: { type: 'memory' },
      web: { http: `127.0.0.1:${port}` },
      oauth2: { skipApprovalScreen: true },
      // A spent token is refused at once, so the spec never waits out a window.
      expiry: { refreshTokens: { reuseInterval: '0s' } },
      staticClients: [{ id: CLIENT_ID, name: 'Trinity E2E', public: true }],
      connectors: [{ type: 'mockCallback', id: 'mock', name: 'Mock' }],
    }),
  );
  const dex = spawn('dex', ['serve', configFile], {
    env: { ...process.env, DEX_SESSIONS_ENABLED: 'true' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  dex.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<never>((_, reject) => {
    dex.once('error', reject);
    // `close`, not `exit`: it waits for stderr, which says why.
    dex.once('close', (code) => {
      reject(new Error(`Dex exited early with ${String(code)}: ${stderrTail}`));
    });
  });
  exited.catch(() => undefined);

  const stop = (): void => {
    dex.kill();
    rmSync(directory, { recursive: true, force: true });
  };

  const grant = async (form: Record<string, string>): Promise<Response> =>
    fetch(`${issuer}/token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: CLIENT_ID, ...form }),
      signal: AbortSignal.timeout(10_000),
    });

  const tokensOf = (body: Record<string, unknown>): DexTokens | undefined => {
    const { access_token: accessToken, refresh_token: refreshToken } = body;
    return typeof accessToken === 'string' && typeof refreshToken === 'string'
      ? { accessToken, refreshToken }
      : undefined;
  };

  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const answered = await Promise.race([
        fetch(`${issuer}/.well-known/openid-configuration`, {
          signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
        }).then(
          (response) => response.ok,
          () => false,
        ),
        exited,
      ]);
      if (answered) break;
      if (Date.now() >= deadline)
        throw new Error(`Dex never became ready: ${stderrTail}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    stop();
    throw error;
  }

  return {
    issuer,
    clientId: CLIENT_ID,
    tokenEndpoint: `${issuer}/token`,
    stop,
    async mint() {
      let url = `${issuer}/auth/mock?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email offline_access',
        state: 'token-refresh-e2e',
      }).toString()}`;
      for (let hop = 0; !url.startsWith(REDIRECT_URI); hop++) {
        const { status, headers } = await fetch(url, { redirect: 'manual' });
        const location = headers.get('location');
        if (!location || hop === 5)
          throw new Error(`Dex's sign-in stopped at hop ${hop} with ${status}`);
        url = new URL(location, url).href;
      }
      const code = new URL(url).searchParams.get('code');
      if (!code) throw new Error("Dex's redirect carried no code");
      const response = await grant({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      });
      const tokens = tokensOf(
        (await response.json()) as Record<string, unknown>,
      );
      if (!tokens)
        throw new Error(`Dex's code exchange answered ${response.status}`);
      return tokens;
    },
    async refresh(refreshToken) {
      const response = await grant({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      const body = (await response.json()) as Record<string, unknown>;
      const tokens = tokensOf(body);
      return {
        status: response.status,
        ...(typeof body['error'] === 'string' ? { error: body['error'] } : {}),
        ...(tokens ? { tokens } : {}),
      };
    },
  };
}
