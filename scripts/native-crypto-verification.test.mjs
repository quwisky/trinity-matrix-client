/**
 * Interactive verification (requests, SAS, QR codes) and its change events.
 *
 * Each case runs one script for a pair (or trio) of devices in every pairing: WASM with WASM
 * (the reference), native requester with WASM responder, WASM requester with native responder,
 * and native with native. Every answer, event and sent request of each role is recorded, and
 * each role of each pairing must match the same role in the reference, step by step, by value.
 * What is random by nature (IDs, keys, MACs, transaction and flow IDs) is compared by where it
 * appears: each distinct random value becomes a numbered placeholder in order of appearance, so
 * a flow ID must recur exactly where WASM's does. Emoji and decimals differ per flow: they are
 * compared by shape against WASM, and the two ends of each flow must show the same ones.
 * Mixed pairings prove interop; the native pair proves the event mirrors on their own.
 */
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  Homeserver,
  covered,
  expectSame,
  hasCargo,
  skipped,
  useDevices,
} from './native-crypto-harness.mjs';

const { RequestType, VerificationRequestPhase: Phase, QrState } = wasm;
/** SAS, QR scan, QR show, reciprocate: what matrix-js-sdk offers. */
const ALL_METHODS = [
  wasm.VerificationMethod.SasV1,
  wasm.VerificationMethod.QrCodeScanV1,
  wasm.VerificationMethod.QrCodeShowV1,
  wasm.VerificationMethod.ReciprocateV1,
];
const ROOM = '!dm:localhost';
const TWO = [
  ['wasm', 'wasm'],
  ['native', 'wasm'],
  ['wasm', 'native'],
  ['native', 'native'],
];
const THREE = [
  ['wasm', 'wasm', 'wasm'],
  ['native', 'wasm', 'wasm'],
  ['wasm', 'native', 'wasm'],
  ['wasm', 'wasm', 'native'],
  ['native', 'native', 'native'],
];

const result = (answer) => {
  expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
  return answer.result;
};

const HEX_ID = /^[0-9a-f]{32}$/;
const RANDOM = /^\$?[A-Za-z0-9+/=_-]{16,}$/;
const EMBEDDED_KEY = /[A-Za-z0-9+/]{43}/g;
/** Fields that differ per flow by nature: compared by shape. */
const PER_FLOW = new Set(['emoji', 'emojiIndex', 'decimals']);
const TIMES = new Set(['timestamp', 'origin_server_ts']);

const typeShape = (value) =>
  Array.isArray(value)
    ? value.map(typeShape)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, typeShape(item)]),
        )
      : typeof value;

/**
 * One role's view of a run: its devices' IDs and keys become labels, random values become
 * placeholders numbered in order of appearance, times become what they mean.
 */
class Normalizer {
  #labels;
  #random = new Map();

  #omit;

  /** `omit`: fields a case compares on its own, left out here. */
  constructor(roles, omit = []) {
    this.#omit = new Set(omit);
    const users = new Map();
    const labels = [];
    for (const [name, device] of Object.entries(roles)) {
      if (!users.has(device.userId)) users.set(device.userId, `<${name} user>`);
      labels.push(
        [device.userId, users.get(device.userId)],
        [device.deviceId, `<${name} device>`],
        [device.identityKeys.ed25519, `<${name} ed25519>`],
        [device.identityKeys.curve25519, `<${name} curve25519>`],
      );
    }
    this.#labels = labels.sort(([a], [b]) => b.length - a.length);
  }

  #placeholder(value) {
    if (!this.#random.has(value))
      this.#random.set(value, `<r${this.#random.size}>`);
    return this.#random.get(value);
  }

  #labelled(text) {
    let out = text;
    for (const [id, label] of this.#labels) out = out.replaceAll(id, label);
    return out;
  }

  string(text) {
    const out = this.#labelled(text);
    if (
      out === text &&
      (HEX_ID.test(text) ||
        (RANDOM.test(text) && /[A-Z]/.test(text) && /[a-z]/.test(text)))
    )
      return this.#placeholder(text);
    return out.replace(EMBEDDED_KEY, (key) => this.#placeholder(key));
  }

  /** The sort key of an object key: its labels, with what is random left out. */
  #order(key) {
    return this.#labelled(key).replace(EMBEDDED_KEY, '').replace(HEX_ID, '');
  }

  /** When the value being normalized was recorded. */
  at = Date.now();

  value(value, name) {
    if (PER_FLOW.has(name)) return typeShape(value);
    if (name === 'expiresAtMs') {
      const left = value - this.at;
      return left > 590_000
        ? 'about 10 minutes'
        : left > 0
          ? 'running'
          : 'expired';
    }
    // Request bodies, raw events and keys are JSON strings: their key order is not compared.
    if (typeof value === 'string' && /^[[{]/.test(value)) {
      try {
        return { json: this.value(JSON.parse(value)) };
      } catch {
        // Not JSON after all.
      }
    }
    if (typeof value === 'number')
      return TIMES.has(name) || value > 1e12 ? '<time>' : value;
    if (typeof value === 'string') return this.string(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (value && typeof value === 'object') {
      const entries = Object.entries(value)
        .filter(([key]) => !this.#omit.has(key))
        .sort(([a], [b]) => this.#order(a).localeCompare(this.#order(b)));
      return Object.fromEntries(
        entries.map(([key, item]) => [this.string(key), this.value(item, key)]),
      );
    }
    return value;
  }
}

const isVerification = (request) =>
  request.type === RequestType.RoomMessage ||
  (request.type === RequestType.ToDevice &&
    request.event_type.startsWith('m.key.verification.'));

/** Creates and uploads `device`'s cross-signing keys and signs its device with them. */
const crossSign = async (server, device) => {
  const requests = result(await device.bootstrapCrossSigning(true));
  if (requests.uploadKeysRequest)
    await server.send(device, requests.uploadKeysRequest);
  server.uploadSigningKeys(device, requests.uploadSigningKeysRequest);
  await server.send(device, requests.uploadSignaturesRequest);
};

const track = async (server, device, users) => {
  await device.updateTrackedUsers(users);
  await server.flush(device);
};

/** Fetches `users`' keys now (setup, not compared). */
const fetchKeys = async (server, device, users) =>
  server.send(device, result(await device.queryKeysForUsers(users)));

let world = 0;

/** Alice (A) and Bob (B), each cross-signed, who know each other and share a DM. */
const twoUsers = async (device, [a, b]) => {
  const server = new Homeserver();
  const roles = { A: await device(a), B: await device(b) };
  for (const it of Object.values(roles)) {
    await server.flush(it);
    await crossSign(server, it);
  }
  for (const it of Object.values(roles))
    await track(server, it, [roles.A.userId, roles.B.userId]);
  server.joinRoom(ROOM, Object.values(roles));
  return { server, roles };
};

/** One user: a new device A and a cross-signed device B (and another device C). */
const oneUser = async (device, kinds) => {
  const server = new Homeserver();
  const userId = `@self${world++}:localhost`;
  const roles = {};
  for (const [index, kind] of kinds.entries()) {
    const name = 'ABC'[index];
    roles[name] = await device(kind, {
      userId,
      // The role name first, so A < B < C whatever the kinds (SAS tie-breaks compare them).
      deviceId: `${name}${kind.toUpperCase()}${world}`,
    });
    await server.flush(roles[name]);
  }
  await crossSign(server, roles.B);
  if (roles.C) {
    // Own verification requests go only to devices the user cross-signed.
    await fetchKeys(server, roles.B, [userId]);
    await server.send(
      roles.B,
      result(await roles.B.verifyDevice(userId, roles.C.deviceId)),
    );
  }
  // The own user is already tracked, and was queried before B cross-signed: query again.
  for (const it of Object.values(roles)) await fetchKeys(server, it, [userId]);
  return { server, roles };
};

/**
 * Received to-device events, the verification events as they are. matrix-sdk-crypto sends its
 * secret requests after a self-verification (slice D's area) in hash-map order with random
 * request IDs, so those are compared by type, action and secret name only, sorted.
 */
const inGossipOrder = (events) => {
  const raw = (event) => JSON.parse(event.rawEvent ?? '{}');
  const isGossip = (event) => raw(event).type?.startsWith('m.secret.');
  const gossip = events
    .filter(isGossip)
    .map((event) => {
      const { type, content } = raw(event);
      return `${type} ${content.action ?? ''} ${content.name ?? ''}`;
    })
    .sort();
  return { verification: events.filter((event) => !isGossip(event)), gossip };
};

/** `events` with those of one flow together, flows in the order `flows` has them. */
const inFlowOrder = (flows, events) => {
  const flow = (event) =>
    flows.indexOf(JSON.parse(event.rawEvent ?? '{}').content?.transaction_id);
  return [...events].sort((a, b) => flow(a) - flow(b));
};

/** The script's handle on one run: its roles, and steps that record each role's answers. */
const context = ({ server, roles }, traces) => {
  const names = Object.keys(roles);
  const record = (name, label, value, view) => {
    traces[name].push({ label, value, view, at: Date.now() });
    return value;
  };
  /** Flow IDs in the order the script made them, to order requests sent together. */
  const flows = [];
  const flowOf = (request) => {
    const body = JSON.parse(request.body);
    const content = body.messages
      ? Object.values(Object.values(body.messages)[0])[0]
      : body;
    return content.transaction_id ?? content['m.relates_to']?.event_id;
  };
  // matrix-sdk-crypto hands out requests queued together in hash-map order.
  const byFlow = (requests) =>
    [...requests].sort(
      (a, b) =>
        flows.indexOf(flowOf(a)) - flows.indexOf(flowOf(b)) ||
        a.event_type.localeCompare(b.event_type),
    );
  const ctx = {
    ...roles,
    flows,
    server,
    /** Runs `run` on a role's device and records its answer (through `view`, if given). */
    step: async (name, label, run, view) =>
      record(name, label, await run(roles[name]), view),
    record,
    send: async (name, request) => {
      if (request) await server.send(roles[name], request);
    },
    sendAll: async (name, requests) => {
      for (const request of requests) await server.send(roles[name], request);
    },
    /**
     * Moves everything until nothing moves: each role sends its outgoing requests, gets its
     * room events and syncs its to-device events. The verification requests sent and what each
     * role receives are recorded.
     */
    settle: async (label) => {
      for (let round = 0; round < 12; round += 1) {
        let moved = 0;
        for (const name of names) {
          const it = roles[name];
          const requests = await it.outgoingRequests();
          const verification = requests.filter(isVerification);
          if (verification.length)
            record(name, `${label}: sent`, verification, byFlow);
          for (const request of requests) {
            await server.send(it, request);
            moved += 1;
          }
          const roomAnswers = await server.syncRooms(it);
          if (roomAnswers.length) {
            record(name, `${label}: room events`, roomAnswers);
            moved += roomAnswers.length;
          }
          if (server.pending(it).length) {
            record(
              name,
              `${label}: to-device`,
              await server.sync(it),
              (events) => inGossipOrder(inFlowOrder(flows, events)),
            );
            moved += 1;
          }
        }
        if (!moved) return;
      }
      throw new Error(`${label}: still moving after 12 rounds`);
    },
    /** A sync with nothing new, which is when the machine collects and times out flows. */
    syncAll: async (label) => {
      for (const name of names)
        record(name, `${label}: sync`, await server.sync(roles[name]));
    },
    /** A flow's request snapshots in a role's events, in order: what its mirror showed. */
    requestHistory: (name, flowId) =>
      traces[name]
        .filter(({ label }) => label.endsWith(': events'))
        .flatMap(({ value }) => value.result.events)
        .filter(
          ({ type, request }) =>
            type === 'verificationRequestChanged' && request.flowId === flowId,
        )
        .map(({ request }) => request),
    /** The last snapshot of a flow's request in a role's events: what its mirror shows. */
    lastRequest: (name, flowId) => ctx.requestHistory(name, flowId).at(-1),
    events: async (label) => {
      for (const name of names)
        await ctx.step(name, `${label}: events`, (it) => it.pollEvents());
    },
  };
  return ctx;
};

/**
 * Runs `phases` (scripts, each on every run before the next starts, with `between` in
 * between) for each pairing, then compares each role of each pairing with the reference.
 */
const runAll = async (
  device,
  pairings,
  setup,
  phases,
  between,
  { omit } = {},
) => {
  const runs = [];
  for (const kinds of pairings) {
    const built = await setup(device, kinds);
    const traces = Object.fromEntries(
      Object.keys(built.roles).map((name) => [name, []]),
    );
    runs.push({ kinds, built, traces, ctx: context(built, traces), state: {} });
  }
  for (const [index, phase] of [phases].flat().entries()) {
    if (index > 0) await between?.();
    for (const run of runs) await phase(run.ctx, run.state);
  }
  const [reference, ...others] = runs;
  for (const run of others) {
    for (const name of Object.keys(reference.traces)) {
      const mine = run.traces[name];
      const theirs = reference.traces[name];
      const where = `${name} in ${run.kinds.join('/')}`;
      expect(
        mine.map(({ label }) => label),
        `the steps of ${where}`,
      ).toEqual(theirs.map(({ label }) => label));
      const normalizers = [
        new Normalizer(run.built.roles, omit),
        new Normalizer(reference.built.roles, omit),
      ];
      mine.forEach((entry, index) =>
        expectSame(
          [entry.value, theirs[index].value],
          `${entry.label} (${where})`,
          (answer, side) => {
            // Each side through its own view and normalizer (a view may know its run's flows).
            const { at, view = (it) => it } = [entry, theirs[index]][side];
            normalizers[side].at = at;
            return normalizers[side].value(view(answer));
          },
        ),
      );
    }
  }
  return runs;
};

/** The phases a role saw in its request events, in order, repeats folded. */
const phasesSeen = (run, name) =>
  run.traces[name]
    .filter(({ label }) => label.endsWith(': events'))
    .flatMap(({ value }) => value.result.events)
    .filter(({ type }) => type === 'verificationRequestChanged')
    .map(({ request }) => request.phase)
    .filter((phase, index, all) => phase !== all[index - 1]);

/** A starts a request to B: in a DM, to-device to B's device, or to A's own other devices. */
const request = async (ctx, how) => {
  const { A, B } = ctx;
  let flowId;
  if (how === 'room') {
    const content = result(
      await ctx.step('A', 'request content', (it) =>
        it.verificationRequestContent(B.userId, ALL_METHODS),
      ),
    );
    // As matrix-js-sdk does (matrix-rust-sdk#5643), add the msgtype before sending.
    flowId = ctx.server.sendRoomEvent(A, ROOM, 'm.room.message', {
      ...JSON.parse(content),
      msgtype: 'm.key.verification.request',
    });
    const created = result(
      await ctx.step('A', 'request', (it) =>
        it.requestIdentityVerification({
          userId: B.userId,
          roomId: ROOM,
          requestEventId: flowId,
          methods: ALL_METHODS,
        }),
      ),
    );
    expect(created.flowId).toBe(flowId);
  } else {
    const [created, toDevice] = result(
      await ctx.step('A', 'request', (it) =>
        how === 'self'
          ? it.requestIdentityVerification({
              userId: A.userId,
              methods: ALL_METHODS,
            })
          : it.requestDeviceVerification(B.userId, B.deviceId, ALL_METHODS),
      ),
    );
    expect(toDevice.type).toBe(RequestType.ToDevice);
    await ctx.send('A', toDevice);
    flowId = created.flowId;
  }
  ctx.flows.push(flowId);
  await ctx.settle('request');
  await ctx.events('request');
  const incoming = result(
    await ctx.step('B', 'incoming request', (it) =>
      it.getVerificationRequest(A.userId, flowId),
    ),
  );
  expect(incoming.phase).toBe(Phase.Requested);
  return flowId;
};

/** B accepts with every method. */
const accept = async (ctx, flowId) => {
  const ready = result(
    await ctx.step('B', 'accept', (it) =>
      it.acceptVerificationRequest(ctx.A.userId, flowId, ALL_METHODS),
    ),
  );
  await ctx.send('B', ready);
  await ctx.settle('accept');
  await ctx.events('accept');
  for (const [name, other] of [
    ['A', ctx.B],
    ['B', ctx.A],
  ]) {
    const ready = result(
      await ctx.step(name, 'ready request', (it) =>
        it.getVerificationRequest(other.userId, flowId),
      ),
    );
    expect(ready.phase).toBe(Phase.Ready);
  }
};

/** A starts SAS and B accepts it, until both show the same emoji; the decimals. */
const sasUntilEmoji = async (ctx, flowId) => {
  const { A, B } = ctx;
  const [, start] = result(
    await ctx.step('A', 'start SAS', (it) => it.startSas(B.userId, flowId)),
  );
  await ctx.send('A', start);
  await ctx.settle('start');
  await ctx.events('start');
  await ctx.step('B', 'started SAS', (it) =>
    it.getVerification(A.userId, flowId),
  );
  await ctx.send(
    'B',
    result(
      await ctx.step('B', 'accept SAS', (it) => it.acceptSas(A.userId, flowId)),
    ),
  );
  await ctx.settle('keys');
  await ctx.events('keys');
  const shown = [];
  for (const [name, other] of [
    ['A', B],
    ['B', A],
  ]) {
    const sas = result(
      await ctx.step(name, 'SAS shown', (it) =>
        it.getVerification(other.userId, flowId),
      ),
    );
    expect(sas.emoji).toHaveLength(7);
    shown.push(sas);
  }
  // Random per flow: both ends of this flow agree.
  expect(shown[0].decimals).toEqual(shown[1].decimals);
  expect(shown[0].emoji).toEqual(shown[1].emoji);
  expect(shown[0].emojiIndex).toEqual(shown[1].emojiIndex);
  return shown[0].decimals;
};

/** Both confirm; with `twice`, each confirms again at once (a double click). */
const confirmSas = async (ctx, flowId, decimals, { twice = false } = {}) => {
  for (const [name, other] of [
    ['A', ctx.B],
    ['B', ctx.A],
  ]) {
    const requests = result(
      await ctx.step(name, 'confirm SAS', (it) =>
        it.confirmSas(other.userId, flowId, decimals),
      ),
    );
    await ctx.sendAll(name, requests);
    if (twice) {
      expect(
        result(
          await ctx.step(name, 'confirm SAS again', (it) =>
            it.confirmSas(other.userId, flowId, decimals),
          ),
        ),
        'nothing left to confirm',
      ).toEqual([]);
    }
  }
  await ctx.settle('confirm');
  await ctx.events('confirm');
};

/** Each role fetches the other's keys again and reads its device and identity. */
const trustAfter = async (ctx) => {
  const roles = Object.entries({ A: ctx.A, B: ctx.B });
  for (const [, it] of roles) {
    await fetchKeys(ctx.server, it, [
      ...new Set(roles.map(([, r]) => r.userId)),
    ]);
  }
  const trust = {};
  for (const [name, it] of roles) {
    const other = name === 'A' ? ctx.B : ctx.A;
    const device = result(
      await ctx.step(name, 'device of the other', () =>
        it.getDevice(other.userId, other.deviceId),
      ),
    );
    const identity = result(
      await ctx.step(name, 'identity of the other', () =>
        it.getIdentity(other.userId),
      ),
    );
    trust[name] = { device: device.isVerified, identity: identity.isVerified };
  }
  return trust;
};

const lastRequestEvent = (run, name) =>
  run.traces[name]
    .filter(({ label }) => label.endsWith(': events'))
    .flatMap(({ value }) => value.result.events)
    .filter(({ type }) => type === 'verificationRequestChanged')
    .at(-1)?.request;

describe.skipIf(!hasCargo)(
  `native crypto verification with WASM${skipped}`,
  () => {
    const device = useDevices();

    covered(
      [
        'OlmMachine.getVerificationRequest',
        'OwnUserIdentity.requestVerification',
        'VerificationRequest.acceptWithMethods',
        'VerificationRequest.startSas',
        'VerificationRequest.registerChangesCallback',
        'VerificationRequest.cancelInfo',
        'VerificationRequest.flowId',
        'VerificationRequest.getVerification',
        'VerificationRequest.isCancelled',
        'VerificationRequest.isPassive',
        'VerificationRequest.isSelfVerification',
        'VerificationRequest.otherDeviceId',
        'VerificationRequest.otherUserId',
        'VerificationRequest.phase',
        'VerificationRequest.roomId',
        'VerificationRequest.theirSupportedMethods',
        'VerificationRequest.timeRemainingMillis',
        'VerificationRequest.weStarted',
        'Sas.accept',
        'Sas.confirm',
        'Sas.registerChangesCallback',
        'Sas.cancelInfo',
        'Sas.decimals',
        'Sas.emoji',
        'Sas.isCancelled',
        'Sas.isDone',
        'Sas.otherUserId',
      ],
      'verifies two devices of one user with SAS, to-device, as WASM does',
      async () => {
        const runs = await runAll(device, TWO, oneUser, async (ctx) => {
          const flowId = await request(ctx, 'self');
          await accept(ctx, flowId);
          const decimals = await sasUntilEmoji(ctx, flowId);
          await confirmSas(ctx, flowId, decimals, { twice: true });
          // Both devices end verified, and the new device trusts its own identity.
          expect(await trustAfter(ctx)).toEqual({
            A: { device: true, identity: true },
            B: { device: true, identity: true },
          });
        });
        for (const run of runs) {
          expect(phasesSeen(run, 'A'), 'requester').toEqual([
            Phase.Ready,
            Phase.Transitioned,
            Phase.Done,
          ]);
          expect(phasesSeen(run, 'B'), 'responder').toEqual([
            Phase.Ready,
            Phase.Transitioned,
            Phase.Done,
          ]);
        }
      },
    );

    covered(
      [
        'OlmMachine.receiveVerificationEvent',
        'OtherUserIdentity.verificationRequestContent',
        'OtherUserIdentity.requestVerification',
        'VerificationRequest.cancelInfo',
        'VerificationRequest.flowId',
        'VerificationRequest.getVerification',
        'VerificationRequest.isCancelled',
        'VerificationRequest.isPassive',
        'VerificationRequest.isSelfVerification',
        'VerificationRequest.otherDeviceId',
        'VerificationRequest.otherUserId',
        'VerificationRequest.phase',
        'VerificationRequest.roomId',
        'VerificationRequest.theirSupportedMethods',
        'VerificationRequest.timeRemainingMillis',
        'VerificationRequest.weStarted',
        'Sas.cancelInfo',
        'Sas.decimals',
        'Sas.emoji',
        'Sas.isCancelled',
        'Sas.isDone',
        'Sas.otherUserId',
      ],
      'verifies another user with SAS in a DM, as WASM does',
      async () => {
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const flowId = await request(ctx, 'room');
          await accept(ctx, flowId);
          const decimals = await sasUntilEmoji(ctx, flowId);
          await confirmSas(ctx, flowId, decimals);
          expect(await trustAfter(ctx)).toEqual({
            A: { device: true, identity: true },
            B: { device: true, identity: true },
          });
        });
      },
    );

    /** S shows a QR code, T scans it; `mode` is the QR code's mode byte. */
    const qrFlow = (how, shower, mode) => async (ctx) => {
      const flowId = await request(ctx, how);
      await accept(ctx, flowId);
      const scanner = shower === 'A' ? 'B' : 'A';
      const other = (name) => (name === 'A' ? ctx.B : ctx.A);
      const shown = result(
        await ctx.step(shower, 'generate QR code', (it) =>
          it.generateQrCode(other(shower).userId, flowId),
        ),
      );
      expect(shown.state).toBe(QrState.Created);
      // Fresh keys and a fresh secret: compared by length and header here, and proven by the
      // other side scanning them.
      const bytes = result(
        await ctx.step(
          shower,
          'QR code bytes',
          (it) => it.qrCodeBytes(other(shower).userId, flowId),
          (answer) => {
            const raw = Buffer.from(answer.result, 'base64');
            return { length: raw.length, header: [...raw.subarray(0, 8)] };
          },
        ),
      );
      // "MATRIX", version 2, then the mode.
      const header = Buffer.from(bytes, 'base64');
      expect(header.subarray(0, 6).toString()).toBe('MATRIX');
      expect([header[6], header[7]]).toEqual([2, mode]);
      await ctx.events('shown');
      const scanned = result(
        await ctx.step(scanner, 'scan QR code', (it) =>
          it.scanQrCode(other(scanner).userId, flowId, bytes),
        ),
      );
      expect(scanned.state).toBe(QrState.Reciprocated);
      await ctx.send(
        scanner,
        result(
          await ctx.step(scanner, 'reciprocate', (it) =>
            it.reciprocateQr(other(scanner).userId, flowId),
          ),
        ),
      );
      await ctx.settle('reciprocate');
      await ctx.events('reciprocate');
      const seen = result(
        await ctx.step(shower, 'scanned', (it) =>
          it.getVerification(other(shower).userId, flowId),
        ),
      );
      expect(seen.hasBeenScanned).toBe(true);
      await ctx.send(
        shower,
        result(
          await ctx.step(shower, 'confirm scanning', (it) =>
            it.confirmQrScanning(other(shower).userId, flowId),
          ),
        ),
      );
      await ctx.settle('confirm');
      await ctx.events('confirm');
      return trustAfter(ctx);
    };

    covered(
      [
        'VerificationRequest.generateQrCode',
        'VerificationRequest.scanQrCode',
        'Qr.confirmScanning',
        'Qr.hasBeenScanned',
        'Qr.reciprocate',
        'Qr.state',
        'Qr.toBytes',
      ],
      'verifies another user by QR code (mode 0) in a DM, as WASM does',
      async () => {
        const runs = await runAll(device, TWO, twoUsers, async (ctx) => {
          expect(await qrFlow('room', 'B', 0)(ctx)).toEqual({
            A: { device: true, identity: true },
            B: { device: true, identity: true },
          });
        });
        for (const run of runs) {
          for (const name of ['A', 'B'])
            expect(lastRequestEvent(run, name).phase, name).toBe(Phase.Done);
        }
      },
    );

    covered(
      [
        'VerificationRequest.generateQrCode',
        'VerificationRequest.scanQrCode',
        'Qr.confirmScanning',
        'Qr.hasBeenScanned',
        'Qr.reciprocate',
        'Qr.state',
        'Qr.toBytes',
      ],
      'verifies an own device by QR code shown by the trusted device (mode 1), as WASM does',
      async () => {
        await runAll(device, TWO, oneUser, async (ctx) => {
          expect(await qrFlow('self', 'B', 1)(ctx)).toEqual({
            A: { device: true, identity: true },
            B: { device: true, identity: true },
          });
        });
      },
    );

    covered(
      [
        'VerificationRequest.generateQrCode',
        'VerificationRequest.scanQrCode',
        'Qr.confirmScanning',
        'Qr.hasBeenScanned',
        'Qr.reciprocate',
        'Qr.state',
        'Qr.toBytes',
      ],
      'verifies an own device by QR code shown by the new device (mode 2), as WASM does',
      async () => {
        await runAll(device, TWO, oneUser, async (ctx) => {
          expect(await qrFlow('self', 'A', 2)(ctx)).toEqual({
            A: { device: true, identity: true },
            B: { device: true, identity: true },
          });
        });
      },
    );

    /**
     * Both roles read the request (it may be collected already, as on WASM); the cancel info
     * each role's events last showed.
     */
    const cancelSeen = async (ctx, flowId, label) => {
      const seen = {};
      for (const [name, other] of [
        ['A', ctx.B],
        ['B', ctx.A],
      ]) {
        await ctx.step(name, label, (it) =>
          it.getVerificationRequest(other.userId, flowId),
        );
        const last = ctx.lastRequest(name, flowId);
        expect(last?.phase, `${name} saw the cancel`).toBe(Phase.Cancelled);
        seen[name] = last.cancelInfo;
      }
      return seen;
    };

    covered(
      [
        'OlmMachine.getVerificationRequest',
        'Device.requestVerification',
        'VerificationRequest.cancel',
        'VerificationRequest.cancelInfo',
        'VerificationRequest.flowId',
        'VerificationRequest.getVerification',
        'VerificationRequest.isCancelled',
        'VerificationRequest.isPassive',
        'VerificationRequest.isSelfVerification',
        'VerificationRequest.otherDeviceId',
        'VerificationRequest.otherUserId',
        'VerificationRequest.phase',
        'VerificationRequest.roomId',
        'VerificationRequest.theirSupportedMethods',
        'VerificationRequest.timeRemainingMillis',
        'VerificationRequest.weStarted',
      ],
      'cancels a request by its requester before it is accepted, as WASM does',
      async () => {
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const flowId = await request(ctx, 'device');
          // Not ready yet: no SAS to start, on both.
          expect(
            result(
              await ctx.step('A', 'start too early', (it) =>
                it.startSas(ctx.B.userId, flowId),
              ),
            ),
          ).toBeNull();
          await ctx.send(
            'A',
            result(
              await ctx.step('A', 'cancel', (it) =>
                it.cancelVerificationRequest(ctx.B.userId, flowId),
              ),
            ),
          );
          await ctx.settle('cancel');
          await ctx.events('cancel');
          const user = 'The user cancelled the verification.';
          expect(await cancelSeen(ctx, flowId, 'cancelled')).toEqual({
            A: { cancelCode: 'm.user', reason: user, cancelledbyUs: true },
            B: { cancelCode: 'm.user', reason: user, cancelledbyUs: false },
          });
        });
      },
    );

    covered(
      [
        'VerificationRequest.cancel',
        'VerificationRequest.cancelInfo',
        'VerificationRequest.flowId',
        'VerificationRequest.getVerification',
        'VerificationRequest.isCancelled',
        'VerificationRequest.isPassive',
        'VerificationRequest.isSelfVerification',
        'VerificationRequest.otherDeviceId',
        'VerificationRequest.otherUserId',
        'VerificationRequest.phase',
        'VerificationRequest.roomId',
        'VerificationRequest.theirSupportedMethods',
        'VerificationRequest.timeRemainingMillis',
        'VerificationRequest.weStarted',
      ],
      'cancels a request by its responder, as WASM does',
      async () => {
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const flowId = await request(ctx, 'device');
          await ctx.send(
            'B',
            result(
              await ctx.step('B', 'decline', (it) =>
                it.cancelVerificationRequest(ctx.A.userId, flowId),
              ),
            ),
          );
          await ctx.settle('decline');
          await ctx.events('decline');
          const seen = await cancelSeen(ctx, flowId, 'declined');
          expect(seen.A).toMatchObject({
            cancelCode: 'm.user',
            cancelledbyUs: false,
          });
          expect(seen.B).toMatchObject({
            cancelCode: 'm.user',
            cancelledbyUs: true,
          });
        });
      },
    );

    covered(
      [
        'Sas.cancelWithCode',
        'Sas.confirm',
        'Sas.cancelInfo',
        'Sas.decimals',
        'Sas.emoji',
        'Sas.isCancelled',
        'Sas.isDone',
        'Sas.otherUserId',
      ],
      'cancels a SAS whose emoji do not match, then confirms nothing on that flow, as WASM does',
      async () => {
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const { A, B } = ctx;
          const flowId = await request(ctx, 'device');
          await accept(ctx, flowId);
          const decimals = await sasUntilEmoji(ctx, flowId);
          await ctx.send(
            'A',
            result(
              await ctx.step('A', 'mismatch', (it) =>
                it.cancelSas(B.userId, flowId, 'm.mismatched_sas'),
              ),
            ),
          );
          await ctx.settle('mismatch');
          await ctx.events('mismatch');
          for (const [name, other, byUs] of [
            ['A', B, true],
            ['B', A, false],
          ]) {
            const sas = result(
              await ctx.step(name, 'cancelled SAS', (it) =>
                it.getVerification(other.userId, flowId),
              ),
            );
            expect(sas.cancelInfo).toEqual({
              cancelCode: 'm.mismatched_sas',
              reason: 'The SAS did not match.',
              cancelledbyUs: byUs,
            });
          }
          // A cancelled flow cannot be confirmed: no request, nothing verified.
          expect(
            result(
              await ctx.step('B', 'confirm cancelled', (it) =>
                it.confirmSas(A.userId, flowId, decimals),
              ),
            ),
          ).toEqual([]);
          // Two syncs collect the flow. WASM's object still answers (no request); the crate no
          // longer finds the flow and refuses it. Neither sends anything.
          await ctx.syncAll('collect');
          await ctx.syncAll('collect again');
          const late = await ctx.step(
            'B',
            'confirm collected',
            (it) => it.confirmSas(A.userId, flowId, decimals),
            (answer) => (answer.error ? [] : answer.result),
          );
          if (B.kind === 'native') {
            expect(late.error.code).toBe('UnknownVerification');
          } else {
            expect(result(late)).toEqual([]);
          }
          await ctx.step('B', 'request collected', (it) =>
            it.getVerificationRequest(A.userId, flowId),
          );
          await ctx.settle('after');
          await fetchKeys(ctx.server, B, [A.userId]);
          expect(
            result(
              await ctx.step('B', 'still unverified', (it) =>
                it.getDevice(A.userId, A.deviceId),
              ),
            ).isVerified,
          ).toBe(false);
        });
      },
    );

    covered(
      [
        'Sas.cancel',
        'Sas.cancelInfo',
        'Sas.decimals',
        'Sas.emoji',
        'Sas.isCancelled',
        'Sas.isDone',
        'Sas.otherUserId',
      ],
      'cancels a SAS with m.user, as WASM does',
      async () => {
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const flowId = await request(ctx, 'device');
          await accept(ctx, flowId);
          await sasUntilEmoji(ctx, flowId);
          await ctx.send(
            'B',
            result(
              await ctx.step('B', 'cancel SAS', (it) =>
                it.cancelSas(ctx.A.userId, flowId),
              ),
            ),
          );
          await ctx.settle('cancel');
          await ctx.events('cancel');
          const seen = await cancelSeen(ctx, flowId, 'cancelled');
          expect(seen.A).toMatchObject({
            cancelCode: 'm.user',
            cancelledbyUs: false,
          });
        });
      },
    );

    covered(
      [
        'VerificationRequest.isPassive',
        'VerificationRequest.cancelInfo',
        'VerificationRequest.flowId',
        'VerificationRequest.getVerification',
        'VerificationRequest.isCancelled',
        'VerificationRequest.isPassive',
        'VerificationRequest.isSelfVerification',
        'VerificationRequest.otherDeviceId',
        'VerificationRequest.otherUserId',
        'VerificationRequest.phase',
        'VerificationRequest.roomId',
        'VerificationRequest.theirSupportedMethods',
        'VerificationRequest.timeRemainingMillis',
        'VerificationRequest.weStarted',
      ],
      'cancels the request on the other own devices with m.accepted once one accepts, as WASM does',
      async () => {
        await runAll(device, THREE, oneUser, async (ctx) => {
          const flowId = await request(ctx, 'self');
          const other = result(
            await ctx.step('C', 'incoming request', (it) =>
              it.getVerificationRequest(ctx.A.userId, flowId),
            ),
          );
          expect(other.phase).toBe(Phase.Requested);
          await accept(ctx, flowId);
          const seen = result(
            await ctx.step('C', 'answered elsewhere', (it) =>
              it.getVerificationRequest(ctx.A.userId, flowId),
            ),
          );
          expect(seen.cancelInfo).toMatchObject({
            cancelCode: 'm.accepted',
            cancelledbyUs: false,
          });
        });
      },
    );

    covered(
      [
        'VerificationRequest.cancelInfo',
        'VerificationRequest.flowId',
        'VerificationRequest.getVerification',
        'VerificationRequest.isCancelled',
        'VerificationRequest.isPassive',
        'VerificationRequest.isSelfVerification',
        'VerificationRequest.otherDeviceId',
        'VerificationRequest.otherUserId',
        'VerificationRequest.phase',
        'VerificationRequest.roomId',
        'VerificationRequest.theirSupportedMethods',
        'VerificationRequest.timeRemainingMillis',
        'VerificationRequest.weStarted',
      ],
      'ignores a start with an unknown method and cancels a SAS start with an unknown key agreement with m.unknown_method, as WASM does',
      async () => {
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const { A, B } = ctx;
          const flowId = await request(ctx, 'device');
          await accept(ctx, flowId);
          const start = (content) => ({
            type: 'm.key.verification.start',
            sender: A.userId,
            content: {
              from_device: A.deviceId,
              transaction_id: flowId,
              ...content,
            },
          });
          // A method nobody knows: matrix-sdk-crypto ignores the start.
          ctx.server.deliver(B, [start({ method: 'org.example.unknown' })]);
          await ctx.settle('unknown method');
          await ctx.events('unknown method');
          expect(
            result(
              await ctx.step('B', 'still ready', (it) =>
                it.getVerificationRequest(A.userId, flowId),
              ),
            ).phase,
          ).toBe(Phase.Ready);
          // SAS with a key agreement nobody knows: cancelled with m.unknown_method.
          ctx.server.deliver(B, [
            start({
              method: 'm.sas.v1',
              key_agreement_protocols: ['org.example.unknown'],
              hashes: ['sha256'],
              message_authentication_codes: ['hkdf-hmac-sha256.v2'],
              short_authentication_string: ['decimal', 'emoji'],
            }),
          ]);
          await ctx.settle('unknown key agreement');
          await ctx.events('unknown key agreement');
          await ctx.step('B', 'after the bad start', (it) =>
            it.getVerificationRequest(A.userId, flowId),
          );
          await ctx.step('A', 'cancelled', (it) =>
            it.getVerificationRequest(B.userId, flowId),
          );
          expect(ctx.lastRequest('A', flowId)?.cancelInfo).toMatchObject({
            cancelCode: 'm.unknown_method',
            cancelledbyUs: false,
          });
        });
      },
    );

    covered(
      ['OlmMachine.getVerificationRequests', 'Device.requestVerification'],
      'cancels both requests when a second one for the same user arrives, as WASM does',
      async () => {
        // The flow IDs are random, so the lists are compared as sorted summaries.
        const summary = (answer) =>
          answer.result
            .map(({ phase, weStarted, cancelInfo }) => ({
              phase,
              weStarted,
              cancelInfo,
            }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const { A, B } = ctx;
          const flows = [];
          for (const label of ['first request', 'second request']) {
            const [created, toDevice] = result(
              await ctx.step('A', label, (it) =>
                it.requestDeviceVerification(B.userId, B.deviceId, ALL_METHODS),
              ),
            );
            await ctx.send('A', toDevice);
            flows.push(created.flowId);
            ctx.flows.push(created.flowId);
          }
          // Before any sync collects them: both of A's requests, as each side lists them.
          const listed = await ctx.step(
            'A',
            'requests',
            (it) => it.getVerificationRequests(B.userId),
            summary,
          );
          expect(listed.result).toHaveLength(2);
          await ctx.settle('requests');
          await ctx.events('requests');
          // B gets both in one sync, before anything collects them.
          const theirs = await ctx.step(
            'B',
            'requests',
            (it) => it.getVerificationRequests(A.userId),
            summary,
          );
          // Each side cancels both, by itself (matrix-sdk-crypto's insert_request).
          const cancelled = (weStarted) => ({
            phase: Phase.Cancelled,
            weStarted,
            cancelInfo: {
              cancelCode: 'm.user',
              reason: 'The user cancelled the verification.',
              cancelledbyUs: true,
            },
          });
          expect({ A: summary(listed), B: summary(theirs) }).toEqual({
            A: [cancelled(true), cancelled(true)],
            B: [cancelled(false), cancelled(false)],
          });
        });
      },
    );

    covered(
      [
        'VerificationRequest.acceptWithMethods',
        'VerificationRequest.cancel',
        'Sas.confirm',
      ],
      'refuses unknown flows without effect, where WASM has no object to call',
      async () => {
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const { A, B } = ctx;
          for (const [label, call] of [
            [
              'accept unknown',
              (it) => it.acceptVerificationRequest(B.userId, 'no-flow'),
            ],
            [
              'cancel unknown',
              (it) => it.cancelVerificationRequest(B.userId, 'no-flow'),
            ],
            [
              'confirm unknown',
              (it) => it.confirmSas(B.userId, 'no-flow', [1, 2, 3]),
            ],
          ]) {
            const answer = await ctx.step('A', label, call, (it) =>
              it.error ? 'refused' : it.result,
            );
            if (A.kind === 'native')
              expect(answer.error.code).toBe('UnknownVerification');
            else expect(answer.error).toBeDefined();
          }
          await ctx.settle('nothing sent');
          expect(
            result(
              await ctx.step('A', 'no requests', (it) =>
                it.getVerificationRequests(B.userId),
              ),
            ),
          ).toEqual([]);
          expect(
            result(
              await ctx.step('A', 'no request', (it) =>
                it.getVerificationRequest(B.userId, 'no-flow'),
              ),
            ),
          ).toBeNull();
        });
      },
    );

    covered(
      [
        'Sas.cancelInfo',
        'VerificationRequest.cancelInfo',
        'VerificationRequest.cancelInfo',
        'VerificationRequest.flowId',
        'VerificationRequest.getVerification',
        'VerificationRequest.isCancelled',
        'VerificationRequest.isPassive',
        'VerificationRequest.isSelfVerification',
        'VerificationRequest.otherDeviceId',
        'VerificationRequest.otherUserId',
        'VerificationRequest.phase',
        'VerificationRequest.roomId',
        'VerificationRequest.theirSupportedMethods',
        'VerificationRequest.timeRemainingMillis',
        'VerificationRequest.weStarted',
      ],
      'times a SAS out with m.timeout after a minute without events, as WASM does',
      async () => {
        await runAll(
          device,
          TWO,
          twoUsers,
          [
            async (ctx, state) => {
              state.flowId = await request(ctx, 'device');
              await accept(ctx, state.flowId);
              const [, start] = result(
                await ctx.step('A', 'start SAS', (it) =>
                  it.startSas(ctx.B.userId, state.flowId),
                ),
              );
              await ctx.send('A', start);
              await ctx.settle('start');
              await ctx.events('start');
            },
            async (ctx, state) => {
              // Before a sync times it out, the SAS already says it has.
              for (const [name, other] of [
                ['A', ctx.B],
                ['B', ctx.A],
              ]) {
                const sas = result(
                  await ctx.step(name, 'expired SAS', (it) =>
                    it.getVerification(other.userId, state.flowId),
                  ),
                );
                expect(sas).toMatchObject({
                  timedOut: true,
                  isCancelled: false,
                });
              }
              await ctx.syncAll('timed out');
              await ctx.settle('cancel');
              await ctx.events('timed out');
              for (const [name, other] of [
                ['A', ctx.B],
                ['B', ctx.A],
              ]) {
                await ctx.step(name, 'timed out SAS', (it) =>
                  it.getVerification(other.userId, state.flowId),
                );
                // Each side times the SAS out itself when it syncs.
                expect(ctx.lastRequest(name, state.flowId).cancelInfo).toEqual({
                  cancelCode: 'm.timeout',
                  reason: 'The verification process timed out.',
                  cancelledbyUs: true,
                });
              }
            },
          ],
          // The SAS times out after 60 seconds without an event (matrix-sdk-crypto's limit).
          () => new Promise((done) => setTimeout(done, 61_000)),
        );
      },
      120_000,
    );

    /** Both ends show the same SAS now; returns its decimals. */
    const sameSas = async (ctx, flowId, label) => {
      const shown = [];
      for (const [name, other] of [
        ['A', ctx.B],
        ['B', ctx.A],
      ]) {
        shown.push(
          result(
            await ctx.step(name, label, (it) =>
              it.getVerification(other.userId, flowId),
            ),
          ),
        );
      }
      expect(shown[0].decimals).toHaveLength(3);
      expect(shown[0].decimals).toEqual(shown[1].decimals);
      expect(shown[0].emoji).toEqual(shown[1].emoji);
      return shown[0].decimals;
    };

    /** B accepts the SAS it holds and both ends exchange keys. */
    const acceptSas = async (ctx, flowId, label) => {
      await ctx.send(
        'B',
        result(
          await ctx.step('B', label, (it) =>
            it.acceptSas(ctx.A.userId, flowId),
          ),
        ),
      );
      await ctx.settle(label);
      await ctx.events(label);
    };

    /** Where `confirmSas` with the decimals of a replaced SAS goes: the crate refuses it. */
    const confirmReplaced = async (ctx, name, flowId, decimals) => {
      const other = name === 'A' ? ctx.B : ctx.A;
      const answer = await ctx.step(
        name,
        'confirm the replaced SAS',
        (it) => it.confirmSas(other.userId, flowId, decimals),
        // Neither sends anything; WASM's new SAS (no keys yet) confirms nothing.
        (it) => (it.error ? [] : it.result),
      );
      if (ctx[name].kind === 'native') {
        expect(answer.error.code).toBe('StaleObject');
      } else {
        expect(result(answer)).toEqual([]);
      }
    };

    covered(
      [
        'VerificationRequest.startSas',
        'VerificationRequest.registerChangesCallback',
        'Sas.accept',
        'Sas.confirm',
        'Sas.registerChangesCallback',
        'Sas.decimals',
        'Sas.emoji',
      ],
      'settles two SAS started at once on the one the lower device started, as WASM does',
      async () => {
        await runAll(device, TWO, oneUser, async (ctx) => {
          const flowId = await request(ctx, 'self');
          await accept(ctx, flowId);
          for (const name of ['A', 'B']) {
            const other = name === 'A' ? ctx.B : ctx.A;
            const [, start] = result(
              await ctx.step(name, 'start SAS at once', (it) =>
                it.startSas(other.userId, flowId),
              ),
            );
            await ctx.send(name, start);
          }
          await ctx.settle('both started');
          await ctx.events('both started');
          // A's device ID sorts lower: B drops its own SAS for A's (one more request change),
          // A ignores B's.
          expect(
            ['A', 'B'].map((name) =>
              ctx.requestHistory(name, flowId).map((it) => it.phase),
            ),
            'the mirrors show the replacement on B',
          ).toEqual([
            [Phase.Ready, Phase.Transitioned],
            [Phase.Ready, Phase.Transitioned, Phase.Transitioned],
          ]);
          // A holds its own SAS, which it cannot accept; B holds A's, which it can.
          expect(
            result(
              await ctx.step('A', 'accept own SAS', (it) =>
                it.acceptSas(ctx.B.userId, flowId),
              ),
            ),
          ).toBeNull();
          await acceptSas(ctx, flowId, 'accept the surviving SAS');
          const decimals = await sameSas(ctx, flowId, 'surviving SAS shown');
          await confirmSas(ctx, flowId, decimals);
          expect(await trustAfter(ctx)).toEqual({
            A: { device: true, identity: true },
            B: { device: true, identity: true },
          });
        });
      },
    );

    covered(
      ['Sas.confirm', 'Sas.decimals', 'Sas.registerChangesCallback'],
      'replaces a SAS whose emoji were shown when a late start of the lower device arrives, and refuses its decimals',
      async () => {
        await runAll(device, TWO, oneUser, async (ctx) => {
          const { A, B } = ctx;
          const flowId = await request(ctx, 'self');
          await accept(ctx, flowId);
          const shown = await sasUntilEmoji(ctx, flowId);
          // A start from A that arrives late (here: delivered again by the server). A's device
          // sorts lower, so B replaces the SAS it showed, as matrix-sdk-crypto does.
          ctx.server.deliver(B, [
            {
              type: 'm.key.verification.start',
              sender: A.userId,
              content: {
                from_device: A.deviceId,
                transaction_id: flowId,
                method: 'm.sas.v1',
                key_agreement_protocols: ['curve25519-hkdf-sha256'],
                hashes: ['sha256'],
                message_authentication_codes: ['hkdf-hmac-sha256.v2'],
                short_authentication_string: ['decimal', 'emoji'],
              },
            },
          ]);
          await ctx.settle('late start');
          await ctx.events('late start');
          const replaced = result(
            await ctx.step('B', 'replaced SAS', (it) =>
              it.getVerification(A.userId, flowId),
            ),
          );
          expect(replaced.decimals).toBeUndefined();
          // The decimals the user saw belong to the replaced SAS.
          await confirmReplaced(ctx, 'B', flowId, shown);
          await ctx.settle('after');
          await fetchKeys(ctx.server, B, [A.userId]);
          expect(
            result(
              await ctx.step('B', 'still unverified', (it) =>
                it.getDevice(A.userId, A.deviceId),
              ),
            ).isVerified,
          ).toBe(false);
        });
      },
    );

    covered(
      [
        'VerificationRequest.generateQrCode',
        'VerificationRequest.startSas',
        'VerificationRequest.getVerification',
        'Sas.registerChangesCallback',
        'Qr.registerChangesCallback',
        'Qr.state',
      ],
      'replaces a shown QR code nobody scanned with a SAS started on the same request, as WASM does',
      async () => {
        await runAll(device, TWO, oneUser, async (ctx) => {
          const { A, B } = ctx;
          const flowId = await request(ctx, 'self');
          await accept(ctx, flowId);
          expect(
            result(
              await ctx.step('B', 'show QR code', (it) =>
                it.generateQrCode(A.userId, flowId),
              ),
            ).state,
          ).toBe(QrState.Created);
          await ctx.events('shown');
          const [, start] = result(
            await ctx.step('A', 'start SAS instead', (it) =>
              it.startSas(B.userId, flowId),
            ),
          );
          await ctx.send('A', start);
          await ctx.settle('start');
          await ctx.events('start');
          expect(
            ctx.requestHistory('B', flowId).map((it) => it.verification?.kind),
            "B's mirror switches from the QR code to the SAS",
          ).toEqual([undefined, 'qr', 'sas']);
          const late = await ctx.step(
            'B',
            'confirm the replaced QR code',
            (it) => it.confirmQrScanning(A.userId, flowId),
            (it) => (it.error ? null : it.result),
          );
          // The crate finds no QR code on the flow; WASM's held one, never scanned, sends nothing.
          if (B.kind === 'native')
            expect(late.error.code).toBe('UnknownVerification');
          else expect(result(late)).toBeNull();
          await acceptSas(ctx, flowId, 'accept SAS');
          const decimals = await sameSas(ctx, flowId, 'SAS shown');
          await confirmSas(ctx, flowId, decimals);
          expect(await trustAfter(ctx)).toEqual({
            A: { device: true, identity: true },
            B: { device: true, identity: true },
          });
        });
      },
    );

    covered(
      [
        'Qr.cancel',
        'Qr.cancelInfo',
        'Qr.isCancelled',
        'Qr.isDone',
        'Qr.otherUserId',
        'Qr.registerChangesCallback',
        'Qr.state',
      ],
      'cancels a scanned QR code, as WASM does',
      async () => {
        await runAll(device, TWO, oneUser, async (ctx) => {
          const { A, B } = ctx;
          const flowId = await request(ctx, 'self');
          await accept(ctx, flowId);
          result(
            await ctx.step('B', 'show QR code', (it) =>
              it.generateQrCode(A.userId, flowId),
            ),
          );
          const bytes = result(
            await ctx.step(
              'B',
              'QR code bytes',
              (it) => it.qrCodeBytes(A.userId, flowId),
              (answer) => Buffer.from(answer.result, 'base64').length,
            ),
          );
          result(
            await ctx.step('A', 'scan', (it) =>
              it.scanQrCode(B.userId, flowId, bytes),
            ),
          );
          await ctx.send(
            'A',
            result(
              await ctx.step('A', 'reciprocate', (it) =>
                it.reciprocateQr(B.userId, flowId),
              ),
            ),
          );
          await ctx.settle('scanned');
          await ctx.events('scanned');
          await ctx.send(
            'B',
            result(
              await ctx.step('B', 'cancel QR code', (it) =>
                it.cancelQr(A.userId, flowId),
              ),
            ),
          );
          const cancelled = result(
            await ctx.step('B', 'cancelled QR code', (it) =>
              it.getVerification(A.userId, flowId),
            ),
          );
          expect(cancelled).toMatchObject({
            kind: 'qr',
            state: QrState.Cancelled,
            isCancelled: true,
            isDone: false,
            cancelInfo: { cancelCode: 'm.user', cancelledbyUs: true },
          });
          await ctx.settle('cancel');
          await ctx.events('cancel');
          const seen = await cancelSeen(ctx, flowId, 'cancelled');
          expect(seen.A).toMatchObject({
            cancelCode: 'm.user',
            cancelledbyUs: false,
          });
        });
      },
    );

    covered(
      [
        'OlmMachine.getVerificationRequest',
        'VerificationRequest.theirSupportedMethods',
      ],
      'ignores a method it does not know in a request and verifies with the others',
      async () => {
        const runs = await runAll(
          device,
          TWO,
          twoUsers,
          async (ctx) => {
            const { A, B } = ctx;
            const [created, toDevice] = result(
              await ctx.step('A', 'request', (it) =>
                it.requestDeviceVerification(B.userId, B.deviceId, ALL_METHODS),
              ),
            );
            // The request on the wire also offers a method nobody knows.
            const body = JSON.parse(toDevice.body);
            const content = body.messages[B.userId][B.deviceId];
            content.methods = [...content.methods, 'org.example.unknown'];
            await ctx.send('A', { ...toDevice, body: JSON.stringify(body) });
            const flowId = created.flowId;
            ctx.flows.push(flowId);
            await ctx.settle('request');
            await ctx.events('request');
            const incoming = result(
              await ctx.step('B', 'incoming request', (it) =>
                it.getVerificationRequest(A.userId, flowId),
              ),
            );
            // The crate leaves the unknown method out; WASM's getter throws on it.
            expect(incoming.theirSupportedMethods).toEqual(
              B.kind === 'native'
                ? ALL_METHODS
                : {
                    throws: expect.stringContaining(
                      'Unknown verification method',
                    ),
                  },
            );
            await accept(ctx, flowId);
            const decimals = await sasUntilEmoji(ctx, flowId);
            await confirmSas(ctx, flowId, decimals);
            expect((await trustAfter(ctx)).A.device).toBe(true);
          },
          undefined,
          // Compared above, per kind.
          { omit: ['theirSupportedMethods'] },
        );
        expect(runs).toHaveLength(4);
      },
    );

    covered(
      ['Sas.accept'],
      'shows no emoji for a SAS whose start offers only decimals, as WASM does',
      async () => {
        await runAll(device, TWO, twoUsers, async (ctx) => {
          const { A, B } = ctx;
          const flowId = await request(ctx, 'device');
          await accept(ctx, flowId);
          ctx.server.deliver(B, [
            {
              type: 'm.key.verification.start',
              sender: A.userId,
              content: {
                from_device: A.deviceId,
                transaction_id: flowId,
                method: 'm.sas.v1',
                key_agreement_protocols: ['curve25519-hkdf-sha256'],
                hashes: ['sha256'],
                message_authentication_codes: ['hkdf-hmac-sha256.v2'],
                short_authentication_string: ['decimal'],
              },
            },
          ]);
          await ctx.settle('decimals only');
          await ctx.events('decimals only');
          const started = result(
            await ctx.step('B', 'started SAS', (it) =>
              it.getVerification(A.userId, flowId),
            ),
          );
          expect(started).toMatchObject({
            kind: 'sas',
            supportsEmoji: false,
            weStarted: false,
          });
          await ctx.step('B', 'accept SAS', (it) =>
            it.acceptSas(A.userId, flowId),
          );
        });
      },
    );

    covered(
      ['VerificationRequest.isPassive', 'VerificationRequest.phase'],
      "goes passive on an own device that sees another own device's ready, then done, as WASM does",
      async () => {
        await runAll(device, THREE, oneUser, async (ctx) => {
          const { A, B, C } = ctx;
          const flowId = await request(ctx, 'self');
          result(
            await ctx.step('C', 'incoming request', (it) =>
              it.getVerificationRequest(A.userId, flowId),
            ),
          );
          const ready = result(
            await ctx.step('B', 'accept', (it) =>
              it.acceptVerificationRequest(A.userId, flowId, ALL_METHODS),
            ),
          );
          // A server that fans the ready out to C as well: C sees its own user answer.
          const content = JSON.parse(ready.body).messages[A.userId][A.deviceId];
          const toC = (type, body) => ({
            type,
            sender: A.userId,
            content: body,
          });
          ctx.server.deliver(C, [toC('m.key.verification.ready', content)]);
          await ctx.send('B', ready);
          await ctx.settle('ready');
          await ctx.events('ready');
          const passive = result(
            await ctx.step('C', 'answered elsewhere', (it) =>
              it.getVerificationRequest(A.userId, flowId),
            ),
          );
          // Passive reads as cancelled with no cancel info, as WASM's phase() maps it.
          expect(passive).toMatchObject({
            isPassive: true,
            phase: Phase.Cancelled,
          });
          expect(passive.cancelInfo).toBeUndefined();
          const decimals = await sasUntilEmoji(ctx, flowId);
          await confirmSas(ctx, flowId, decimals);
          ctx.server.deliver(C, [
            toC('m.key.verification.done', { transaction_id: flowId }),
          ]);
          await ctx.settle('done elsewhere');
          await ctx.events('done elsewhere');
          expect(ctx.lastRequest('C', flowId)).toMatchObject({
            phase: Phase.Done,
            isPassive: false,
          });
        });
      },
    );
  },
);
