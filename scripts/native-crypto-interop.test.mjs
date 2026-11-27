/**
 * The native crypto crate (native/crypto) and the WASM package the web app ships must
 * interoperate as two devices, and emit the same request shapes for the same step. The
 * native side runs as its JSON-lines CLI; a tiny in-test homeserver carries the keys and
 * to-device messages between them.
 *
 * Without cargo on PATH the suite is skipped and says why; in CI (`CI` set) a missing cargo
 * fails instead, so the job cannot pass without running it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import { format, resolveConfig } from 'prettier';

const root = resolve(import.meta.dirname, '..');
const hasCargo = spawnSync('cargo', ['--version']).status === 0;
if (!hasCargo && process.env.CI) {
  throw new Error('The native crypto interop test needs cargo in CI.');
}
const skipped = hasCargo ? '' : ' (skipped: cargo is not on PATH)';
if (!hasCargo) {
  console.warn(`native crypto interop${skipped}; install Rust to run it.`);
}

/** Builds the CLI (incrementally) and returns its path, or fails with cargo's output. */
const buildCli = () => {
  const manifest = resolve(root, 'native/crypto/Cargo.toml');
  const args = ['build', '--locked', '--bin', 'trinity-crypto-cli'];
  const result = spawnSync(
    'cargo',
    [
      ...args,
      '--manifest-path',
      manifest,
      '--message-format=json-render-diagnostics',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `cargo build of native/crypto failed:\n${result.stderr.slice(-4000)}`,
    );
  }
  const executable = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .find(
      (message) =>
        message.target?.name === 'trinity-crypto-cli' && message.executable,
    )?.executable;
  if (!executable)
    throw new Error('cargo build did not report the trinity-crypto-cli binary');
  return executable;
};

const startCli = (executable) => {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  return {
    async call(request) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const { value, done } = await lines.next();
      if (done) throw new Error('trinity-crypto-cli exited');
      return JSON.parse(value);
    },
    stop: () => child.stdin.end(),
  };
};

const REQUEST_FIELDS = [
  'id',
  'type',
  'body',
  'event_type',
  'txn_id',
  'room_id',
  'version',
];
const plain = (request) =>
  Object.fromEntries(
    REQUEST_FIELDS.filter((field) => request[field] !== undefined).map(
      (field) => [field, request[field]],
    ),
  );

const nativeDevice = async (cli, userId, deviceId) => {
  const call = async (method, params = {}) => {
    const response = await cli.call({ method, userId, deviceId, params });
    if (response.error)
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const { identityKeys } = await call('init');
  return {
    kind: 'native',
    userId,
    deviceId,
    identityKeys,
    outgoingRequests: () => call('outgoingRequests'),
    markRequestAsSent: (requestId, requestType, response) =>
      call('markRequestAsSent', { requestId, requestType, response }),
    receiveSyncChanges: (toDeviceEvents, oneTimeKeysCounts) =>
      call('receiveSyncChanges', {
        toDeviceEvents,
        changedDevices: { changed: [], left: [] },
        oneTimeKeysCounts,
      }),
    updateTrackedUsers: (users) => call('updateTrackedUsers', { users }),
    getMissingSessions: (users) => call('getMissingSessions', { users }),
    shareRoomKey: (roomId, users) => call('shareRoomKey', { roomId, users }),
    encryptRoomEvent: (roomId, eventType, content) =>
      call('encryptRoomEvent', { roomId, eventType, content }),
    async decryptRoomEvent(event, roomId) {
      const decrypted = await call('decryptRoomEvent', {
        event,
        roomId,
        decryptionSettings: {
          sender_device_trust_requirement: wasm.TrustRequirement.Untrusted,
        },
      });
      return { ...decrypted, shieldColor: decrypted.shieldState.lax.color };
    },
    close: () => call('close'),
  };
};

const wasmDevice = async (userId, deviceId) => {
  const machine = await wasm.OlmMachine.initialize(
    new wasm.UserId(userId),
    new wasm.DeviceId(deviceId),
  );
  const users = (list) => list.map((user) => new wasm.UserId(user));
  return {
    kind: 'wasm',
    userId,
    deviceId,
    identityKeys: {
      ed25519: machine.identityKeys.ed25519.toBase64(),
      curve25519: machine.identityKeys.curve25519.toBase64(),
    },
    outgoingRequests: async () => (await machine.outgoingRequests()).map(plain),
    markRequestAsSent: (id, type, response) =>
      machine.markRequestAsSent(id, type, response),
    receiveSyncChanges: async (toDeviceEvents, counts) =>
      (
        await machine.receiveSyncChanges(
          toDeviceEvents,
          new wasm.DeviceLists(),
          new Map(Object.entries(counts)),
          new Set(),
        )
      ).map(({ type, rawEvent }) => ({ type, rawEvent })),
    updateTrackedUsers: (list) => machine.updateTrackedUsers(users(list)),
    getMissingSessions: async (list) => {
      const request = await machine.getMissingSessions(users(list));
      return request ? plain(request) : null;
    },
    shareRoomKey: async (roomId, list) =>
      (
        await machine.shareRoomKey(
          new wasm.RoomId(roomId),
          users(list),
          new wasm.EncryptionSettings(),
        )
      ).map(plain),
    encryptRoomEvent: (roomId, eventType, content) =>
      machine.encryptRoomEvent(new wasm.RoomId(roomId), eventType, content),
    async decryptRoomEvent(event, roomId) {
      const decrypted = await machine.decryptRoomEvent(
        event,
        new wasm.RoomId(roomId),
        new wasm.DecryptionSettings(wasm.TrustRequirement.Untrusted),
      );
      return {
        event: decrypted.event,
        sender: decrypted.sender.toString(),
        senderCurve25519Key: decrypted.senderCurve25519Key,
        shieldColor: decrypted.shieldState(false).color,
      };
    },
    close: () => machine.close(),
  };
};

/** Placeholders for IDs and key IDs, so two runs of the same step compare equal. */
const shapeOf = (value, device) => {
  const key = (name) =>
    name
      .replaceAll(device.userId, '<user>')
      .replace(/^@[^:]+:localhost$/, '<other user>')
      .replace(
        /^(signed_curve25519|curve25519|ed25519):(.+)$/,
        (_, algorithm, id) =>
          `${algorithm}:${id === device.deviceId ? '<device>' : '<key>'}`,
      )
      .replace(new RegExp(`^${device.deviceId}$`), '<device>')
      .replace(/^[A-Z]+\d+$/, '<other device>')
      .replace(/^[A-Za-z0-9+/]{43}$/, '<curve25519 key>');
  const shape = (node, name) => {
    if (Array.isArray(node)) return node.map((item) => shape(item));
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node)
          .map(([child, item]) => [key(child), shape(item, child)])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    if (['type', 'event_type', 'algorithm'].includes(name)) return node;
    return node === null ? 'null' : typeof node;
  };
  return shape({ ...value, body: JSON.parse(value.body) });
};

class Homeserver {
  deviceKeys = new Map();
  oneTimeKeys = new Map();
  inbox = new Map();
  /** The first request of each type a device kind sent, as a shape. */
  shapes = { native: {}, wasm: {} };

  #respond(device, request) {
    const body = JSON.parse(request.body);
    const { RequestType } = wasm;
    switch (request.type) {
      case RequestType.KeysUpload: {
        if (body.device_keys) {
          this.deviceKeys.set(device.userId, {
            [device.deviceId]: body.device_keys,
          });
        }
        const keys = this.#otks(device.userId, device.deviceId);
        keys.push(...Object.entries(body.one_time_keys ?? {}));
        return { one_time_key_counts: { signed_curve25519: keys.length } };
      }
      case RequestType.KeysQuery: {
        const found = Object.keys(body.device_keys).filter((user) =>
          this.deviceKeys.has(user),
        );
        return {
          device_keys: Object.fromEntries(
            found.map((user) => [user, this.deviceKeys.get(user)]),
          ),
          failures: {},
        };
      }
      case RequestType.KeysClaim: {
        const claimed = {};
        for (const [user, devices] of Object.entries(body.one_time_keys)) {
          for (const target of Object.keys(devices)) {
            const [id, key] = this.#otks(user, target).pop();
            claimed[user] = { [target]: { [id]: key } };
          }
        }
        return { one_time_keys: claimed, failures: {} };
      }
      case RequestType.ToDevice: {
        for (const [user, devices] of Object.entries(body.messages)) {
          for (const [target, content] of Object.entries(devices)) {
            this.#queue(user, target).push({
              type: request.event_type,
              sender: device.userId,
              content,
            });
          }
        }
        return {};
      }
      default:
        throw new Error(`unexpected request type ${request.type}`);
    }
  }

  #otks(user, device) {
    const id = `${user}|${device}`;
    if (!this.oneTimeKeys.has(id)) this.oneTimeKeys.set(id, []);
    return this.oneTimeKeys.get(id);
  }

  #queue(user, device) {
    const id = `${user}|${device}`;
    if (!this.inbox.has(id)) this.inbox.set(id, []);
    return this.inbox.get(id);
  }

  async send(device, request) {
    this.shapes[device.kind][request.type] ??= shapeOf(request, device);
    const response = this.#respond(device, request);
    await device.markRequestAsSent(
      request.id,
      request.type,
      JSON.stringify(response),
    );
  }

  async flush(device) {
    for (const request of await device.outgoingRequests())
      await this.send(device, request);
  }

  pending(device) {
    return [...this.#queue(device.userId, device.deviceId)];
  }

  deliver(device, events) {
    this.#queue(device.userId, device.deviceId).push(...events);
  }

  async sync(device) {
    const events = this.#queue(device.userId, device.deviceId).splice(0);
    const counts = {
      signed_curve25519: this.#otks(device.userId, device.deviceId).length,
    };
    return device.receiveSyncChanges(JSON.stringify(events), counts);
  }
}

/** Both devices publish keys and track each other; `sender` claims a key and shares a room key. */
const shareRoom = async (server, sender, receiver, roomId) => {
  await server.flush(sender);
  await server.flush(receiver);
  for (const device of [sender, receiver]) {
    await device.updateTrackedUsers([sender.userId, receiver.userId]);
    await server.flush(device);
  }
  const claim = await sender.getMissingSessions([receiver.userId]);
  expect(claim?.type).toBe(wasm.RequestType.KeysClaim);
  await server.send(sender, claim);
  for (const share of await sender.shareRoomKey(roomId, [
    sender.userId,
    receiver.userId,
  ])) {
    await server.send(sender, share);
  }
};

const roomEvent = (sender, roomId, content) =>
  JSON.stringify({
    type: 'm.room.encrypted',
    event_id: `$${Math.random().toString(36).slice(2)}:localhost`,
    sender: sender.userId,
    origin_server_ts: Date.now(),
    room_id: roomId,
    content: JSON.parse(content),
  });

const { Decrypted, UnableToDecrypt } = wasm.ProcessedToDeviceEventType;
let counter = 0;

describe.skipIf(!hasCargo)(`native crypto interop with WASM${skipped}`, () => {
  let cli;
  const devices = [];
  const device = async (kind) => {
    const userId = `@${kind}${counter++}:localhost`;
    const deviceId = `${kind.toUpperCase()}${counter}`;
    const created =
      kind === 'native'
        ? await nativeDevice(cli, userId, deviceId)
        : await wasmDevice(userId, deviceId);
    devices.push(created);
    return created;
  };

  beforeAll(async () => {
    await wasm.initAsync();
    cli = startCli(buildCli());
  });

  afterAll(async () => {
    for (const created of devices) await created.close();
    cli?.stop();
  });

  describe.each([
    ['native', 'wasm'],
    ['wasm', 'native'],
  ])('%s encrypts, %s decrypts', (senderKind, receiverKind) => {
    it('exchanges a room key and a message', async () => {
      const server = new Homeserver();
      const sender = await device(senderKind);
      const receiver = await device(receiverKind);
      const roomId = '!interop:localhost';
      await shareRoom(server, sender, receiver, roomId);

      const received = await server.sync(receiver);
      expect(received.map(({ type }) => type)).toEqual([Decrypted]);
      expect(JSON.parse(received[0].rawEvent).type).toBe('m.room_key');

      const content = JSON.stringify({
        msgtype: 'm.text',
        body: `from ${senderKind}`,
      });
      const encrypted = await sender.encryptRoomEvent(
        roomId,
        'm.room.message',
        content,
      );
      const decrypted = await receiver.decryptRoomEvent(
        roomEvent(sender, roomId, encrypted),
        roomId,
      );
      expect(JSON.parse(decrypted.event).content).toEqual(JSON.parse(content));
      expect(decrypted.sender).toBe(sender.userId);
      expect(decrypted.senderCurve25519Key).toBe(
        sender.identityKeys.curve25519,
      );
      // Neither device is cross-signed, so both sides show the same red shield.
      expect(decrypted.shieldColor).toBe(wasm.ShieldColor.Red);
    });

    it('reports a replayed to-device message and keeps the session working', async () => {
      const server = new Homeserver();
      const sender = await device(senderKind);
      const receiver = await device(receiverKind);
      await shareRoom(server, sender, receiver, '!first:localhost');
      const copy = server.pending(receiver);

      expect((await server.sync(receiver)).map(({ type }) => type)).toEqual([
        Decrypted,
      ]);
      server.deliver(receiver, copy);
      expect((await server.sync(receiver)).map(({ type }) => type)).toEqual([
        UnableToDecrypt,
      ]);

      for (const share of await sender.shareRoomKey('!second:localhost', [
        sender.userId,
        receiver.userId,
      ])) {
        await server.send(sender, share);
      }
      expect((await server.sync(receiver)).map(({ type }) => type)).toEqual([
        Decrypted,
      ]);
    });
  });

  it('emits the same request shapes as WASM for the same steps', async () => {
    const server = new Homeserver();
    await shareRoom(
      server,
      await device('native'),
      await device('wasm'),
      '!a:localhost',
    );
    await shareRoom(
      server,
      await device('wasm'),
      await device('native'),
      '!b:localhost',
    );

    const { RequestType } = wasm;
    expect(Object.keys(server.shapes.wasm).map(Number).sort()).toEqual(
      [
        RequestType.KeysUpload,
        RequestType.KeysQuery,
        RequestType.KeysClaim,
        RequestType.ToDevice,
      ].sort(),
    );
    expect(server.shapes.native).toEqual(server.shapes.wasm);
    // Written as Prettier writes it, so `pnpm format:check` accepts the updated file.
    const golden = resolve(
      import.meta.dirname,
      'native-crypto-interop.golden.json',
    );
    const options = { ...(await resolveConfig(golden)), filepath: golden };
    await expect(
      await format(JSON.stringify(server.shapes.wasm), options),
    ).toMatchFileSnapshot(golden);
  });
});
