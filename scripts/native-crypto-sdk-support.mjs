/**
 * What the native crypto SDK test beds share: matrix-js-sdk clients with crypto on the native
 * shim (the crate's CLI as the bridge) or on WASM, against the disposable homeserver.
 *
 * Needs cargo (the CLI) and Docker (the homeserver); without either a bed is skipped and says
 * why, and with `CI` set it fails instead.
 */
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import { ClientEvent, createClient } from 'matrix-js-sdk';
import { repairStaleMembership } from '../libs/data-access/matrix-client/src/lib/stale-membership-repair.ts';
import { installNativeCrypto } from '../libs/native/crypto-backend/src/index.ts';
import { openE2EInvocation } from '../e2e/support/invocation.mts';
import {
  HOMESERVER_HTTP,
  REGISTRATION_SHARED_SECRET,
} from '../e2e/support/homeserver/constants.mjs';
import { startCliBridge } from './native-crypto-cli-bridge.mjs';
import { buildCli, hasCargo } from './native-crypto-harness.mjs';

const hasDocker = spawnSync('docker', ['info']).status === 0;
if (!hasDocker && process.env.CI) {
  throw new Error('The native crypto SDK test bed needs Docker in CI.');
}
export const missing = !hasCargo
  ? 'cargo is not on PATH'
  : !hasDocker
    ? 'Docker is not available'
    : '';
if (missing) console.warn(`native crypto SDK test bed skipped: ${missing}.`);

const verbose = Boolean(process.env.NATIVE_CRYPTO_SDK_LOG);
const quiet = {
  trace() {},
  debug() {},
  info() {},
  warn: (...args) => verbose && console.warn(...args),
  error: (...args) => verbose && console.error(...args),
  getChild: () => quiet,
};

export const until = async (check, what, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${typeof what === 'function' ? what() : what}`,
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
};

export const api = async (path, { token, method = 'GET', body } = {}) => {
  const response = await fetch(`${HOMESERVER_HTTP}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${path}: ${response.status} ${text}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  return JSON.parse(text);
};

/** A new user (random name), logged in; `password` answers user-interactive auth. */
export const registerAndLogin = async (name) => {
  const username = `${name}-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  const { nonce } = await api('/_synapse/admin/v1/register');
  const mac = createHmac('sha1', REGISTRATION_SHARED_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  await api('/_synapse/admin/v1/register', {
    method: 'POST',
    body: { nonce, username, password, admin: false, mac },
  });
  return login({ username, password });
};

/** Another login of the same user: a new device, or `deviceId` again. */
export const login = async ({ username, password }, deviceId) => {
  const answer = await api('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
      ...(deviceId ? { device_id: deviceId } : {}),
    },
  });
  return {
    userId: answer.user_id,
    deviceId: answer.device_id,
    accessToken: answer.access_token,
    username,
    password,
  };
};

const passwordAuth = (account, session) => ({
  type: 'm.login.password',
  identifier: { type: 'm.id.user', user: account.username },
  password: account.password,
  ...(session ? { session } : {}),
});

/** matrix-js-sdk's user-interactive auth callback, answered with the account's password. */
export const uiaWith = (account) => async (makeRequest) => {
  try {
    await makeRequest(null);
  } catch (error) {
    if (error?.httpStatus !== 401) throw error;
    await makeRequest(passwordAuth(account, error.data?.session));
  }
};

/** Deletes a device on the server (the password answers user-interactive auth). */
export const deleteDevice = async (account, deviceId) => {
  const path = `/_matrix/client/v3/devices/${encodeURIComponent(deviceId)}`;
  try {
    await api(path, { token: account.accessToken, method: 'DELETE', body: {} });
  } catch (error) {
    if (error.status !== 401) throw error;
    const { session } = JSON.parse(error.body);
    await api(path, {
      token: account.accessToken,
      method: 'DELETE',
      body: { auth: passwordAuth(account, session) },
    });
  }
};

/**
 * A fetch that can hold back the to-device events of /sync responses and hand them over in a
 * later one: the room message arrives before its room key.
 */
const syncNetwork = () => {
  const held = [];
  const network = {
    holding: false,
    /** /sync requests made: a client whose sync waits makes none. */
    syncs: 0,
    fetchFn: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const isSync = url.includes('/_matrix/client/v3/sync');
      if (isSync) network.syncs++;
      const response = await fetch(input, init);
      if (!isSync || !response.ok) return response;
      if (!network.holding && held.length === 0) return response;
      const body = await response.json();
      const events = body.to_device?.events ?? [];
      body.to_device = {
        events: network.holding ? [] : [...held.splice(0), ...events],
      };
      if (network.holding) held.push(...events);
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
  return network;
};

let cliPath;
let storeRoot;

/** Builds the CLI and starts the homeserver: a bed's `beforeAll`. */
export const openBed = async () => {
  await wasm.initAsync();
  cliPath = buildCli();
  storeRoot = mkdtempSync(join(tmpdir(), 'native-crypto-sdk-'));
  return openE2EInvocation({ resources: ['homeserver'] });
};

/** Stops what `openBed` started: a bed's `afterAll`. */
export const closeBed = async (invocation) => {
  await invocation?.close();
  if (storeRoot) rmSync(storeRoot, { recursive: true, force: true });
};

/**
 * A logged-in client with crypto: on the shim (`native`, a SQLite store with `storeKey` in its
 * own CLI process) or on WASM (memory store: Node has no IndexedDB). `clientOptions` go to
 * `createClient` (such as `cryptoCallbacks`).
 */
export const startClient = async (
  kind,
  account,
  { storeKey, clientOptions } = {},
) => {
  const network = syncNetwork();
  const client = createClient({
    baseUrl: HOMESERVER_HTTP,
    userId: account.userId,
    deviceId: account.deviceId,
    accessToken: account.accessToken,
    fetchFn: network.fetchFn,
    logger: quiet,
    ...clientOptions,
  });
  // As the app does: Tuwunel can send a `state_after` that lags the same response's timeline
  // (a join beside the invite it replaces), and the SDK applies only `state_after`.
  repairStaleMembership(client);
  let bridge;
  const lost = [];
  if (kind === 'native') {
    bridge = startCliBridge(cliPath);
    const { uninstallForTests } = await installNativeCrypto({
      bridge,
      storeDirectory: storeRoot,
      logger: quiet,
      onMachineLost: (reason) => lost.push(reason),
    });
    // Installed only around this client's init: the other clients of the process stay on
    // WASM, and the shim's machine keeps working once its factories are restored.
    try {
      await client.initRustCrypto({
        cryptoDatabasePrefix: `${account.userId}|${account.deviceId}`,
        storageKey: storeKey,
      });
    } catch (error) {
      await bridge.stop();
      throw error;
    } finally {
      uninstallForTests();
    }
  } else {
    await client.initRustCrypto({ useIndexedDB: false });
  }
  const prepared = new Promise((done) =>
    client.on(ClientEvent.Sync, (state) => state === 'PREPARED' && done()),
  );
  await client.startClient({ initialSyncLimit: 50, pollTimeout: 1000 });
  await prepared;
  return {
    kind,
    account,
    client,
    network,
    bridge,
    storeKey,
    lost,
    clientOptions,
  };
};

/** Starts a native client with a fresh store key, a WASM one without. */
export const startParty = async (kind, account, clientOptions) =>
  startClient(kind, account, {
    storeKey: kind === 'native' ? randomBytes(32) : undefined,
    clientOptions,
  });

export const stopClient = async (party) => {
  party.client.stopClient();
  await party.bridge?.stop();
};

/** The machine under the client's RustCrypto: a shim object owns no wasm pointer. */
export const machineOf = (party) => party.client.getCrypto().olmMachine;

export const eventIn = (party, roomId, eventId) =>
  party.client
    .getRoom(roomId)
    ?.getLiveTimeline()
    .getEvents()
    .find((event) => event.getId() === eventId);

const describeEvent = (event) =>
  event
    ? JSON.stringify({
        type: event.getType(),
        failure: event.decryptionFailureReason,
        clear: event.getClearContent(),
        status: event.status,
      })
    : 'no event';

export const decrypted = (party, roomId, eventId, what, timeoutMs) =>
  until(
    () => {
      const event = eventIn(party, roomId, eventId);
      return (
        event?.isEncrypted() &&
        !event.isBeingDecrypted() &&
        !event.isDecryptionFailure() &&
        event.getClearContent()?.body &&
        event
      );
    },
    () =>
      `${party.kind} ${party.account.userId} to decrypt ${what} (${describeEvent(eventIn(party, roomId, eventId))}; sync ${party.client.getSyncState()})`,
    timeoutMs,
  );

/** The event, once its decryption failed. */
export const undecryptable = (party, roomId, eventId, what) =>
  until(
    () => {
      const event = eventIn(party, roomId, eventId);
      return event?.isDecryptionFailure() && event;
    },
    () =>
      `${party.kind} ${party.account.userId} to fail to decrypt ${what} (${describeEvent(eventIn(party, roomId, eventId))})`,
  );

export const joined = async (party, roomId, userId) => {
  try {
    await until(
      () =>
        party.client.getRoom(roomId)?.getMember(userId)?.membership === 'join',
      () =>
        `${party.account.userId} to see ${userId} join (${party.client.getRoom(roomId)?.getMember(userId)?.membership}, sync ${party.client.getSyncState()}, ${party.network.syncs} syncs)`,
    );
  } catch (error) {
    const members = await api(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      { token: party.account.accessToken },
    ).catch((failure) => failure.message);
    throw new Error(
      `${error.message}; the server's joined members: ${JSON.stringify(Object.keys(members.joined ?? members))}`,
    );
  }
};

/**
 * An encrypted room `creator` makes, which every member joins; resolves once every party sees
 * every member joined and the room encrypted.
 */
export const encryptedRoom = async (creator, members) => {
  const { room_id: roomId } = await creator.client.createRoom({
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
    ],
  });
  const encrypted = (party) =>
    until(
      () => party.client.getRoom(roomId)?.hasEncryptionStateEvent(),
      `${party.account.userId} to see the room encrypted`,
    );
  await encrypted(creator);
  for (const member of members) {
    await creator.client.invite(roomId, member.account.userId);
    await until(
      () => member.client.getRoom(roomId),
      `${member.account.userId} to get the invite`,
    );
    await member.client.joinRoom(roomId);
    await encrypted(member);
  }
  const everyone = [creator, ...members];
  for (const viewer of everyone) {
    for (const member of everyone) {
      await joined(viewer, roomId, member.account.userId);
    }
  }
  return roomId;
};

export const send = async (party, roomId, body) =>
  (await party.client.sendTextMessage(roomId, body)).event_id;

export const deviceKeysOnServer = async (viewer, account) => {
  const answer = await api('/_matrix/client/v3/keys/query', {
    token: viewer.account.accessToken,
    method: 'POST',
    body: { device_keys: { [account.userId]: [] } },
  });
  return answer.device_keys[account.userId] ?? {};
};

export const ORIENTATIONS = {
  shim: [
    ['native', 'wasm'],
    ['wasm', 'native'],
  ],
  control: [['wasm', 'wasm']],
};
