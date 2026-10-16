/**
 * Real log formats from matrix-js-sdk and Trinity, with identifiers that must not survive
 * export. A new log format that carries an identifier gets a case here; the spec fails
 * when one survives. `expected` is the output of a fresh redactor over {@link CORPUS_CONTEXT}.
 */
export const ALICE = '@alice:example.org';
export const BOB = '@bob:other.net';
export const ROOM = '!OGEhHVWSdvArJzumhm:example.org';
export const ROOM_V12 = '!_hBKqFYY_kv5ZJr3J1TWDtkwtDDb-xHKas1VOqg6YYZ';
export const EVENT = '$PtYgjmUhBel31iEl2hpChYgCfrL1spNxnyVmihA_2O7';
export const EVENT_2 = '$6UMFxFkM_R5Kjp1vRt-1fjORS_6ilI8ihN5KXSc7Tvo';
export const OWN_DEVICE = 'QWERTYUIOP';
export const BOB_DEVICE = 'ZXCVBNMASD';
export const CURVE_KEY = 'Yn9ZhyiA4uoRgnatmUdjAWtGSU8po+799NksnRH9ucA';
export const SESSION_ID = 'UsdMlHUvTCQCyEZDz/TddJ8HyS5SUkCnD8zRA9a9Skp';
export const MEDIA_ID = 'yYTWmElBYOvfZUzDzVfUkkib';
export const HOMESERVER = 'https://matrix.example.org';
const MAS_TOKEN = 'mat_7xYQ2m9KpL4vR8sT1wE6nB3cZ0aDfGhJ_1a2b3c';
const SYNAPSE_TOKEN = 'syt_YWxpY2U_HnJqTqkVwGzQHkFzXrUm_1fXqZb';

export const CORPUS_CONTEXT = {
  selfUserIds: [ALICE],
  selfDeviceIds: [OWN_DEVICE],
  homeserverUrls: [HOMESERVER],
};

/**
 * Percent-encode the way matrix-js-sdk builds request paths (`encodeUri` in utils.js uses
 * `encodeURIComponent`, which leaves "!" literal: room IDs arrive as `!opaque%3Aserver`).
 */
const path = (id: string): string => encodeURIComponent(id);

export interface RedactionCase {
  readonly name: string;
  readonly line: string;
  readonly secrets: readonly string[];
  readonly expected: string;
}

export const REDACTION_CORPUS: readonly RedactionCase[] = [
  {
    name: 'sync request',
    line: `FetchHttpApi: --> GET ${HOMESERVER}/_matrix/client/v3/sync?filter=xxx&timeout=xxx&since=xxx`,
    secrets: ['matrix.example.org'],
    expected:
      'FetchHttpApi: --> GET https://server2/_matrix/client/v3/sync?filter=xxx&timeout=xxx&since=xxx',
  },
  {
    name: 'room send path',
    line: `FetchHttpApi: --> PUT ${HOMESERVER}/_matrix/client/v3/rooms/${path(ROOM)}/send/m.room.encrypted/m1728640000000.3`,
    secrets: ['OGEhHVWSdvArJzumhm', 'example.org'],
    expected:
      'FetchHttpApi: --> PUT https://server2/_matrix/client/v3/rooms/!room1%3Aserver1/send/m.room.encrypted/m1728640000000.3',
  },
  {
    name: 'room v12 path',
    line: `FetchHttpApi: --> GET ${HOMESERVER}/_matrix/client/v3/rooms/${path(ROOM_V12)}/messages?dir=xxx&from=xxx`,
    secrets: [ROOM_V12.slice(1)],
    expected:
      'FetchHttpApi: --> GET https://server2/_matrix/client/v3/rooms/!room1/messages?dir=xxx&from=xxx',
  },
  {
    name: 'profile path',
    line: `FetchHttpApi: --> GET ${HOMESERVER}/_matrix/client/v3/profile/${path(BOB)}`,
    secrets: ['bob', 'other.net'],
    expected:
      'FetchHttpApi: --> GET https://server2/_matrix/client/v3/profile/%40user1%3Aserver3',
  },
  {
    name: 'remote echo',
    line: `Got remote echo for event ~${ROOM}:m1728640000000.3 -> ${EVENT} old status sending`,
    secrets: [ROOM, EVENT],
    expected:
      'Got remote echo for event ~!room1:server1:m1728640000000.3 -> $event1 old status sending',
  },
  {
    name: 'state entry',
    line: `Updated state entry m.room.member ${BOB} to ${EVENT}`,
    secrets: [BOB, EVENT],
    expected: 'Updated state entry m.room.member @user1:server3 to $event1',
  },
  {
    name: 'event sent',
    line: `Event sent to ${ROOM} with event id ${EVENT_2}`,
    secrets: [ROOM, EVENT_2],
    expected: 'Event sent to !room1:server1 with event id $event1',
  },
  {
    name: 'megolm session',
    line: `Got update for session ${SESSION_ID} from sender ${CURVE_KEY} in ${ROOM}`,
    secrets: [SESSION_ID, CURVE_KEY, ROOM],
    expected:
      'Got update for session <redacted> from sender <redacted> in !room1:server1',
  },
  {
    name: 'verification',
    line: `Incoming verification event ${EVENT} type m.key.verification.request from ${BOB}`,
    secrets: [EVENT, BOB],
    expected:
      'Incoming verification event $event1 type m.key.verification.request from @user1:server3',
  },
  {
    name: 'to-device',
    line: `sendToDevice: sending m.room_key_request to ${BOB}:${BOB_DEVICE} and ${ALICE}:${OWN_DEVICE}`,
    secrets: [BOB, BOB_DEVICE, ALICE, OWN_DEVICE],
    expected:
      'sendToDevice: sending m.room_key_request to @user1:server3:DEVICE2 and @me:server1:DEVICE1',
  },
  {
    name: 'device field',
    line: `[trinity] Matrix request failed {"operation":"verify device","deviceId":"${BOB_DEVICE}","httpStatus":404}`,
    secrets: [BOB_DEVICE],
    expected:
      '[trinity] Matrix request failed {"operation":"verify device","deviceId":"DEVICE2","httpStatus":404}',
  },
  {
    name: 'oidc refresh',
    line: `OAuth2: <-- POST https://auth.example.org/oauth2/token [212ms 200] {"access_token":"${MAS_TOKEN}","refresh_token":"mar_Q1w2E3r4T5y6U7i8O9p0_9z8y7x","expires_in":300}`,
    secrets: [MAS_TOKEN, 'mar_Q1w2E3r4T5y6U7i8O9p0_9z8y7x', 'auth.example.org'],
    expected:
      'OAuth2: <-- POST https://server3/oauth2/token [212ms 200] {"access_token":"<redacted>","refresh_token":"<redacted>","expires_in":300}',
  },
  {
    name: 'push hand-off',
    line: `[trinity] push hand-off for ${ALICE} (${OWN_DEVICE}) via https://push.example.net {"Authorization":"Bearer ${SYNAPSE_TOKEN}"}`,
    secrets: [ALICE, OWN_DEVICE, SYNAPSE_TOKEN, 'push.example.net'],
    expected:
      '[trinity] push hand-off for @me:server1 (DEVICE1) via https://server3 {"Authorization":"<redacted>"}',
  },
  {
    name: 'widget',
    line: `Widget: loading https://widgets.example.net/jitsi.html?roomId=${path(ROOM)}&userId=${path(ALICE)}&access_token=abc123`,
    secrets: ['OGEhHVWSdvArJzumhm', 'alice', 'abc123', 'widgets.example.net'],
    expected:
      'Widget: loading https://server3/jitsi.html?roomId=!room1%3Aserver1&userId=%40me%3Aserver1&access_token=<redacted>',
  },
  {
    name: 'alias',
    line: `joinRoom[#general:example.org]: preJoinMembership=invite, inviter=${BOB}, opts={}`,
    secrets: ['#general', BOB],
    expected:
      'joinRoom[#alias1:server1]: preJoinMembership=invite, inviter=@user1:server3, opts={}',
  },
  {
    name: 'media',
    line: `Fetching key bundle mxc://example.org/${MEDIA_ID}`,
    secrets: [MEDIA_ID, 'example.org'],
    expected: 'Fetching key bundle mxc://server1/media1',
  },
  {
    // An SDK MatrixError printed by Angular's ErrorHandler: its message embeds the request
    // URL, which carries the token on the XHR upload path.
    name: 'matrix error with token url',
    line: `M_UNKNOWN_TOKEN: MatrixError: [401] Invalid access token passed. (${HOMESERVER}/_matrix/media/v3/upload?filename=photo.jpg&access_token=${SYNAPSE_TOKEN})`,
    secrets: [SYNAPSE_TOKEN, 'matrix.example.org'],
    expected:
      // The masked value runs to the next separator, closing parenthesis included: a raw
      // value may contain one, and nothing after it may survive.
      'M_UNKNOWN_TOKEN: MatrixError: [401] Invalid access token passed. (https://server2/_matrix/media/v3/upload?filename=photo.jpg&access_token=<redacted>',
  },
  {
    name: 'error code',
    line: 'MatrixError: [403] You are not invited to this room. (M_FORBIDDEN) /_matrix/client/v3/keys/device_signing/upload',
    secrets: [],
    expected:
      'MatrixError: [403] You are not invited to this room. (M_FORBIDDEN) /_matrix/client/v3/keys/device_signing/upload',
  },
];
