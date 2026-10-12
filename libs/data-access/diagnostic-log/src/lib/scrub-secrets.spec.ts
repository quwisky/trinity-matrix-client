import { describe, expect, it } from 'vitest';
import {
  MAX_SCRUB_INPUT,
  REDACTED,
  scrubMessage,
  scrubSecrets,
} from './scrub-secrets';

const SYNAPSE_TOKEN = 'syt_YWxpY2U_HnJqTqkVwGzQHkFzXrUm_1fXqZb';
const MAS_TOKEN = 'mat_7xYQ2m9KpL4vR8sT1wE6nB3cZ0aDfGhJ_1a2b3c';
const MAS_REFRESH = 'mar_Q1w2E3r4T5y6U7i8O9p0_9z8y7x';
const LOGIN_TOKEN = 'aBcDeFgH12345678';
const FCM_TOKEN =
  'dQw4w9WgXcQ:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqxA3ib4xXN3UJrqCi0f5k8e7Ti';
const APNS_TOKEN =
  '5f2c4e8a9b1d3f7e6a0c2b4d8e1f3a5c7b9d0e2f4a6c8b1d3e5f7a9c0b2d4e6f';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLXZhbHVl';
const RECOVERY_KEY =
  'EsTc LW2K PGiF wKEA 3As5 g5c4 BXwk qeeJ ZJV8 Q9fu gUMN UE4d';
const CURVE_KEY = 'Yn9ZhyiA4uoRgnatmUdjAWtGSU8po+799NksnRH9ucA';
const ALICE = '@alice:example.org';
const ROOM = '!OGEhHVWSdvArJzumhm:example.org';
const ROOM_V12 = '!_hBKqFYY_kv5ZJr3J1TWDtkwtDDb-xHKas1VOqg6YYZ';
const EVENT = '$PtYgjmUhBel31iEl2hpChYgCfrL1spNxnyVmihA_2O7';

/**
 * Shapes that can reach the console in this codebase, each with the secrets it carries.
 * Raw objects get there through Angular's ErrorHandler (`console.error('ERROR', error)`) and
 * the window listeners; Trinity's own warnings pass allowlisted diagnostics only.
 */
const CAPTURED_SHAPES: readonly {
  readonly name: string;
  readonly line: string;
  readonly secrets: readonly string[];
}[] = [
  {
    // matrix-js-sdk MatrixError embeds the request URL; the XHR upload path puts the token
    // in the query when the Authorization header is not used (http-api/index.js:110-111).
    name: 'SDK MatrixError printed by the error handler, its URL carrying the token',
    line: `M_UNKNOWN_TOKEN: MatrixError: [401] Invalid access token passed. (https://matrix.example.org/_matrix/media/v3/upload?filename=photo.jpg&access_token=${SYNAPSE_TOKEN})`,
    secrets: [SYNAPSE_TOKEN],
  },
  {
    // libs/util/matrix/src/lib/session.model.ts, passed whole.
    name: 'MatrixSession object',
    line: `{"baseUrl":"https://matrix.example.org","userId":"${ALICE}","deviceId":"QWERTYUIOP","accessToken":"${MAS_TOKEN}","refreshToken":"${MAS_REFRESH}","accessTokenExpiresAt":1760000000000,"oidc":{"issuer":"https://auth.example.org/","clientId":"01JABCDEFG"}}`,
    secrets: [MAS_TOKEN, MAS_REFRESH],
  },
  {
    // AuthService.completeSsoLogin (libs/data-access/auth/src/lib/auth.service.ts:160).
    name: 'token login request',
    line: `{"type":"m.login.token","token":"${LOGIN_TOKEN}","initial_device_display_name":"Trinity","device_id":"QWERTYUIOP"}`,
    secrets: [LOGIN_TOKEN],
  },
  {
    // AuthService OIDC grant handed to account establishment (auth.service.ts:214-219).
    name: 'OIDC grant',
    line: `{"user_id":"${ALICE}","device_id":"QWERTYUIOP","access_token":"${MAS_TOKEN}","refresh_token":"${MAS_REFRESH}","accessTokenExpiresAt":1760000000000}`,
    secrets: [MAS_TOKEN, MAS_REFRESH],
  },
  {
    // CALLBACK_PARAMS in trinity-application-session.adapter.ts: legacy SSO.
    name: 'native SSO callback',
    line: `dev.trinityproject.trinity://sso-callback?loginToken=${LOGIN_TOKEN}&sso_state=Qm9ndXNTdGF0ZQ`,
    secrets: [LOGIN_TOKEN, 'Qm9ndXNTdGF0ZQ'],
  },
  {
    // CALLBACK_PARAMS: OIDC authorization response.
    name: 'native OIDC callback',
    line: 'dev.trinityproject.trinity://sso-callback?code=Xy7pQ2rT9vW4&state=aB3dE5fG7h&iss=https%3A%2F%2Fauth.example.org%2F',
    secrets: ['Xy7pQ2rT9vW4', 'aB3dE5fG7h'],
  },
  {
    name: 'user-interactive auth with a password',
    line: '{"auth":{"type":"m.login.password","identifier":{"type":"m.id.user","user":"alice"},"password":"hunter2","session":"xyzSESSION"},"new_password":"correct horse"}',
    secrets: ['hunter2', 'correct horse'],
  },
  {
    name: '/voip/turnServer response',
    line: `{"username":"1760000000:${ALICE}","password":"JlKfBy1QwLrO20385QyAtEyIv0=","uris":["turn:turn.example.org:3478?transport=udp"],"ttl":86400}`,
    secrets: ['JlKfBy1QwLrO20385QyAtEyIv0=', `1760000000:${ALICE}`],
  },
  {
    name: '/openid/request_token response',
    line: '{"access_token":"ZmFrZW9wZW5pZA","token_type":"Bearer","matrix_server_name":"example.org","expires_in":3600}',
    secrets: ['ZmFrZW9wZW5pZA'],
  },
  {
    name: 'pusher registration',
    line: `{"pushkey":"${FCM_TOKEN}","kind":"http","app_id":"dev.trinityproject.trinity","data":{"url":"https://push.example.net/_matrix/push/v1/notify"}}`,
    secrets: [FCM_TOKEN],
  },
];

describe('scrubSecrets', () => {
  it('masks bearer credentials and Authorization headers', () => {
    expect(scrubSecrets(`Authorization: Bearer ${SYNAPSE_TOKEN}`)).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(scrubSecrets(`{"Authorization":"Bearer ${SYNAPSE_TOKEN}"}`)).toBe(
      `{"Authorization":"${REDACTED}"}`,
    );
  });

  it('masks Synapse and MAS tokens and JWTs wherever they appear', () => {
    expect(
      scrubSecrets(`token ${SYNAPSE_TOKEN} then ${MAS_TOKEN} and ${JWT}`),
    ).toBe(`token ${REDACTED} then ${REDACTED} and ${REDACTED}`);
  });

  it('masks credential query parameters and keeps the others', () => {
    expect(
      scrubSecrets(
        'https://example.org/_matrix/media/v3/download/x?access_token=QWEasd123zxc&allow_redirect=true',
      ),
    ).toBe(
      `https://example.org/_matrix/media/v3/download/x?access_token=${REDACTED}&allow_redirect=true`,
    );
    expect(
      scrubSecrets('https://app.example/callback?code=abc123&state=s1'),
    ).toBe(`https://app.example/callback?code=${REDACTED}&state=${REDACTED}`);
  });

  it('masks credential, key and message-content fields in JSON', () => {
    expect(
      scrubSecrets(
        '{"password":"hunter2","body":"meet me at 6","formatted_body":"<b>meet</b>","msgtype":"m.text"}',
      ),
    ).toBe(
      `{"password":"${REDACTED}","body":"${REDACTED}","formatted_body":"${REDACTED}","msgtype":"m.text"}`,
    );
  });

  it('masks recovery keys and long key material, even after a %-escape', () => {
    expect(scrubSecrets(`restore with ${RECOVERY_KEY}`)).toBe(
      `restore with ${REDACTED}`,
    );
    expect(scrubSecrets(`sender ${CURVE_KEY} and %20${CURVE_KEY}`)).toBe(
      `sender ${REDACTED} and %20${REDACTED}`,
    );
  });

  it('masks precise locations', () => {
    expect(scrubSecrets('share geo:51.5008,0.1247;u=35 now')).toBe(
      `share geo:${REDACTED} now`,
    );
  });

  it('keeps Matrix identifiers for the export redactor, encoded or not', () => {
    const line = `Event sent to ${ROOM} by ${ALICE} with event id ${EVENT} in ${ROOM_V12}, path /rooms/${encodeURIComponent(EVENT)}`;

    expect(scrubSecrets(line)).toBe(line);
  });

  it('leaves ordinary log lines alone', () => {
    const sync =
      'FetchHttpApi: --> GET https://matrix.example.org/_matrix/client/v3/sync?filter=xxx&timeout=xxx';
    const error =
      'MatrixError: [403] You are not invited to this room. (M_FORBIDDEN) OLM_V1_CURVE25519_AES_SHA2 /_matrix/client/v3/keys/device_signing/upload';

    expect(scrubSecrets(sync)).toBe(sync);
    expect(scrubSecrets(error)).toBe(error);
  });

  it('masks Basic and other Authorization schemes, and Cookie values', () => {
    expect(scrubSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(scrubSecrets('Cookie: session=abc123; csrftoken=xyz')).toBe(
      `Cookie: ${REDACTED}`,
    );
    expect(scrubSecrets('Set-Cookie: id=a3fWa; Secure; HttpOnly')).toBe(
      `Set-Cookie: ${REDACTED}`,
    );
    expect(scrubSecrets('{"cookie":"session=abc123"}')).toBe(
      `{"cookie":"${REDACTED}"}`,
    );
  });

  it('masks the whole user-interactive auth dict, nested identifier included', () => {
    expect(
      scrubSecrets(
        '{"auth":{"type":"m.login.password","identifier":{"type":"m.id.user","user":"alice"},"password":"hunter2","session":"xyz"},"new_password":"correct horse"}',
      ),
    ).toBe(`{"auth":"${REDACTED}","new_password":"${REDACTED}"}`);
  });

  it('masks OIDC and registration secrets in JSON, query strings and form bodies', () => {
    expect(
      scrubSecrets(
        '{"client_secret":"s3cr3t","code_verifier":"dBjftJeZ4CVP","registration_token":"r3g1st3r","id_token":"abc"}',
      ),
    ).toBe(
      `{"client_secret":"${REDACTED}","code_verifier":"${REDACTED}","registration_token":"${REDACTED}","id_token":"${REDACTED}"}`,
    );
    expect(
      scrubSecrets(
        'https://auth.example.org/oauth2/token?client_secret=s3cr3t&grant_type=authorization_code',
      ),
    ).toBe(
      `https://auth.example.org/oauth2/token?client_secret=${REDACTED}&grant_type=authorization_code`,
    );
    expect(
      scrubSecrets(
        'grant_type=authorization_code&code=Xy7&code_verifier=dBj&redirect_uri=https%3A%2F%2Fapp',
      ),
    ).toBe(
      `grant_type=authorization_code&code=${REDACTED}&code_verifier=${REDACTED}&redirect_uri=https%3A%2F%2Fapp`,
    );
    expect(scrubSecrets('password=hunter2&username=alice')).toBe(
      `password=${REDACTED}&username=alice`,
    );
  });

  it('keeps diagnostic codes and sync states but masks opaque code and state values', () => {
    expect(
      scrubSecrets(
        '{"code":"M_FORBIDDEN","kind":"http"} {"code":"active-account-unavailable"} {"state":"SYNCING"} {"code":"Xy7pQ2rT9vW4","state":"aB3dE5fG7h"}',
      ),
    ).toBe(
      `{"code":"M_FORBIDDEN","kind":"http"} {"code":"active-account-unavailable"} {"state":"SYNCING"} {"code":"${REDACTED}","state":"${REDACTED}"}`,
    );
  });

  it('masks push keys and FCM and APNs tokens', () => {
    expect(scrubSecrets(`{"pushkey":"${FCM_TOKEN}","kind":"http"}`)).toBe(
      `{"pushkey":"${REDACTED}","kind":"http"}`,
    );
    expect(scrubSecrets(`registered FCM token ${FCM_TOKEN}`)).not.toContain(
      FCM_TOKEN.slice(12),
    );
    expect(scrubSecrets(`apns token ${APNS_TOKEN}`)).toBe(
      `apns token ${REDACTED}`,
    );
  });

  it('masks TURN credentials and OpenID tokens and keeps the server name', () => {
    expect(
      scrubSecrets(
        '{"username":"1760000000:@alice:example.org","password":"JlKfBy1QwLrO20385QyAtEyIv0=","ttl":86400}',
      ),
    ).toBe(`{"username":"${REDACTED}","password":"${REDACTED}","ttl":86400}`);
    expect(
      scrubSecrets(
        '{"access_token":"ZmFrZW9wZW5pZA","token_type":"Bearer","matrix_server_name":"example.org"}',
      ),
    ).toBe(
      `{"access_token":"${REDACTED}","token_type":"Bearer","matrix_server_name":"example.org"}`,
    );
  });

  it('masks pickle, backup and secret storage keys and passphrases', () => {
    expect(
      scrubSecrets(
        '{"pickleKey":"aGVsbG8","backupKey":"d29ybGQ","secretStorageKey":"Zm9v","passphrase":"correct horse"}',
      ),
    ).toBe(
      `{"pickleKey":"${REDACTED}","backupKey":"${REDACTED}","secretStorageKey":"${REDACTED}","passphrase":"${REDACTED}"}`,
    );
  });

  it('masks a secret whose JSON value was cut off', () => {
    expect(scrubSecrets('{"password":"hunter2 and more')).toBe(
      `{"password":"${REDACTED}"`,
    );
  });

  it.each(CAPTURED_SHAPES.map((shape) => [shape.name, shape] as const))(
    'never keeps a secret from the shapes Trinity and the SDK produce: %s',
    (_name, shape) => {
      const scrubbed = scrubSecrets(shape.line);

      for (const secret of shape.secrets) {
        expect(scrubbed).not.toContain(secret);
      }
    },
  );
});

describe('scrubMessage', () => {
  it('scrubs like scrubSecrets', () => {
    expect(scrubMessage(`Authorization: Bearer ${SYNAPSE_TOKEN}`)).toBe(
      `Authorization: ${REDACTED}`,
    );
  });

  it('drops a token cut by the input limit instead of keeping part of it', () => {
    const before = `${'w'.repeat(MAX_SCRUB_INPUT - 10)} `;

    const scrubbed = scrubMessage(`${before}${SYNAPSE_TOKEN} tail`);

    expect(scrubbed).not.toContain('syt_');
    expect(scrubbed.endsWith(' [rest dropped before scrubbing]')).toBe(true);
    expect(scrubbed.length).toBeLessThanOrEqual(MAX_SCRUB_INPUT + 40);
  });
});
