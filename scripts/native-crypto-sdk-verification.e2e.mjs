/**
 * matrix-js-sdk's interactive verification, secrets, room key bundles and dehydrated devices on
 * the native crypto shim against a real homeserver. In each orientation the requester of every
 * flow runs on the first kind and the responder on the second, so the shim requests in one and
 * WASM in the other; the control runs everything on WASM. Every flow goes through js-sdk's
 * public API and is asserted on both ends: self-verification (SAS, and QR shown by the trusted
 * and by the new device), user verification in a DM (SAS and QR), the phases each side emits,
 * cancels by each side at each stage, a mismatched SAS, the request's time limit, a second
 * request while one is pending, a request that arrives while the shim client is offline, secret
 * gossip after verification, a secrets bundle moved to a new device, room history shared on
 * invite (MSC4268) both ways, and a dehydrated device made by the shim and rehydrated by new
 * logins on both backends.
 *
 * Not drivable in Node: QR sign-in (MSC4108 needs a rendezvous server), so the secrets bundle
 * goes through `exportSecretsBundle` / `importSecretsBundle`, the calls that flow makes.
 *
 * Needs cargo and Docker; see native-crypto-sdk-support.mjs.
 */
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from 'matrix-js-sdk/lib/crypto-api/index.js';
import {
  closeBed,
  decrypted,
  deleteDevice,
  dumpTrace,
  encryptedRoom,
  joined,
  login,
  machineOf,
  missing,
  openBed,
  ORIENTATIONS,
  registerAndLogin,
  send,
  startClient,
  startParty,
  stopClient,
  trace,
  traceMark,
  uiaWith,
  undecryptable,
  until,
} from './native-crypto-sdk-support.mjs';

const crypto = (party) => party.client.getCrypto();
const { Requested, Ready, Started, Cancelled, Done } = VerificationPhase;

/** Secret storage callbacks holding one user's key, shared by the user's devices. */
const storageOf = (secrets) => ({
  cryptoCallbacks: {
    getSecretStorageKey: async ({ keys }) =>
      secrets.privateKey && keys[secrets.keyId]
        ? [secrets.keyId, secrets.privateKey]
        : null,
    cacheSecretStorageKey: (keyId, _info, privateKey) => {
      secrets.keyId = keyId;
      secrets.privateKey = privateKey;
    },
  },
});

/** A client that records every verification request it receives. */
const startVerifier = async (kind, account, clientOptions) => {
  const party = await startParty(kind, account, clientOptions);
  watchRequests(party);
  return party;
};

const watchRequests = (party) => {
  party.incoming = [];
  party.client.on(CryptoEvent.VerificationRequestReceived, (request) =>
    party.incoming.push(request),
  );
};

const refresh = async (party) => {
  await machineOf(party).markAllTrackedUsersAsDirty();
  await crypto(party).outgoingRequestsManager.doProcessOutgoingRequests();
};

/** Waits for `check`, querying keys again now and then. */
const eventually = (party, check, what, timeoutMs = 60_000) => {
  let tries = 0;
  return until(
    async () => {
      const value = await check();
      if (!value && ++tries % 10 === 0) await refresh(party);
      return value;
    },
    what,
    timeoutMs,
  );
};

const incomingOf = (party, flowId) =>
  until(
    () => party.incoming.find((request) => request.transactionId === flowId),
    `${party.kind} ${party.account.deviceId} to receive request ${flowId}`,
  );

const phaseIs = (request, phase, what) =>
  until(
    () => request.phase === phase,
    () =>
      `${what} to reach phase ${phase} (now ${request.phase}, cancelled ${request.cancellationCode} by ${request.cancellingUserId})`,
  );

/** Where the current flow's trace starts (`NATIVE_CRYPTO_TRACE`, see the support file). */
let flowMark = 0;

/** `promise`, or an error naming `what` once 30 s passed (the trace is dumped then). */
const settled = (promise, what) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, fail) => {
      timer = setTimeout(() => {
        dumpTrace(flowMark, `stuck: ${what()}`);
        fail(new Error(`timed out waiting for ${what()}`));
      }, 30_000);
    }),
  ]);
};

/** Traces what matrix-js-sdk shows of a request and its verifier. */
const traced = (label, request) =>
  request.on(VerificationRequestEvent.Change, () =>
    trace(`js ${label} ${request.transactionId} phase ${request.phase}`),
  );
const tracedVerifier = (label, verifier, done) => {
  for (const name of Object.values(VerifierEvent))
    verifier.on(name, () => trace(`js ${label} verifier ${name}`));
  done.then(
    () => trace(`js ${label} verify resolved`),
    (error) => trace(`js ${label} verify rejected: ${error.message}`),
  );
};

/** The phases a request goes through, as its Change events show them (repeats folded). */
const track = (request) => {
  const phases = [request.phase];
  request.on(VerificationRequestEvent.Change, () => {
    if (phases.at(-1) !== request.phase) phases.push(request.phase);
  });
  return phases;
};

/** The verifier events a verifier emits, in order. */
const trackVerifier = (verifier) => {
  const seen = [];
  for (const name of Object.values(VerifierEvent))
    verifier.on(name, () => seen.push(name));
  return seen;
};

const sasOf = (verifier) =>
  verifier.getShowSasCallbacks() ??
  new Promise((done) => verifier.once(VerifierEvent.ShowSas, done));

const deviceStatus = (viewer, subject) =>
  crypto(viewer).getDeviceVerificationStatus(
    subject.account.userId,
    subject.account.deviceId,
  );

const crossSign = async (party) => {
  await crypto(party).bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: uiaWith(party.account),
  });
  await until(
    () => crypto(party).isCrossSigningReady(),
    `${party.account.userId} to be cross-signing ready`,
  );
};

/**
 * Waits until `viewer` knows `subject`'s device: upstream ignores a request from a device it has
 * not downloaded yet, on either backend.
 */
const knows = async (viewer, subject) => {
  const started = Date.now();
  await eventually(
    viewer,
    async () => (await deviceStatus(viewer, subject)) !== null,
    `${viewer.account.deviceId} to know ${subject.account.deviceId}`,
  );
  learning[viewer.kind].push(Date.now() - started);
};
/** How long each backend took to learn another device's keys in `knows`, in ms. */
const learning = { native: [], wasm: [] };

/** A request from `from` and the same request as `to` received it, both tracked. */
const requestPair = async (from, to, start) => {
  flowMark = traceMark();
  trace(
    `flow: ${from.kind} ${from.account.deviceId} requests ${to.kind} ${to.account.deviceId}`,
  );
  await knows(to, from);
  await knows(from, to);
  const request = await start();
  const incoming = await incomingOf(to, request.transactionId);
  return {
    request,
    incoming,
    phases: { request: track(request), incoming: track(incoming) },
  };
};

/** SAS to done from a pair whose responder has not accepted yet. */
const runSas = async ({ request, incoming }) => {
  traced('requester', request);
  traced('responder', incoming);
  await incoming.accept();
  await phaseIs(request, Ready, 'the requester');
  const verifier = await request.startVerification('m.sas.v1');
  await phaseIs(incoming, Started, 'the responder');
  const other = incoming.verifier;
  const events = {
    request: trackVerifier(verifier),
    incoming: trackVerifier(other),
  };
  const state = () =>
    `requester ${request.phase} ${JSON.stringify(events.request)}, responder ${incoming.phase} ${JSON.stringify(events.incoming)}`;
  const done = [verifier.verify(), other.verify()];
  tracedVerifier('requester', verifier, done[0]);
  tracedVerifier('responder', other, done[1]);
  const [mine, theirs] = await settled(
    Promise.all([sasOf(verifier), sasOf(other)]),
    () => `both sides to show the SAS (${state()})`,
  );
  expect(mine.sas.emoji).toHaveLength(7);
  expect(mine.sas).toEqual(theirs.sas);
  await settled(
    Promise.all([mine.confirm(), theirs.confirm()]),
    () => `both confirmations (${state()})`,
  );
  await settled(
    Promise.all(done),
    () => `both verifiers to finish (${state()})`,
  );
  await phaseIs(request, Done, 'the requester');
  await phaseIs(incoming, Done, 'the responder');
  return events;
};

/** QR to done: `shower` shows the code, `scanner` scans it; both sides of one pair. */
const runQr = async (pair, showerSide) => {
  const shower = pair[showerSide];
  const scanner = pair[showerSide === 'request' ? 'incoming' : 'request'];
  traced('shower', shower);
  traced('scanner', scanner);
  await pair.incoming.accept();
  await phaseIs(pair.request, Ready, 'the requester');
  await phaseIs(pair.incoming, Ready, 'the responder');
  expect(shower.otherPartySupportsMethod('m.qr_code.scan.v1')).toBe(true);
  const bytes = await shower.generateQRCode();
  expect(bytes).toBeInstanceOf(Uint8ClampedArray);
  expect(shower.phase).toBe(Ready);
  const scanned = await scanner.scanQRCode(bytes);
  const scanDone = scanned.verify();
  tracedVerifier('scanner', scanned, scanDone);
  await phaseIs(shower, Started, 'the shower');
  const shown = shower.verifier;
  const callbacks = shown.getReciprocateQrCodeCallbacks();
  expect(callbacks).not.toBeNull();
  const showDone = shown.verify();
  tracedVerifier('shower', shown, showDone);
  callbacks.confirm();
  await settled(
    Promise.all([scanDone, showDone]),
    () =>
      `both QR verifiers to finish (shower ${shower.phase}, scanner ${scanner.phase}, shown QR done ${shown.hasBeenCancelled})`,
  );
  await phaseIs(shower, Done, 'the shower');
  await phaseIs(scanner, Done, 'the scanner');
};

const FLOW = [Requested, Ready, Started, Done];

describe.skipIf(missing)(
  'matrix-js-sdk verification, secrets, bundles and dehydrated devices on the native crypto shim',
  () => {
    let invocation;
    afterEach(({ task }) => {
      if (task.result?.state === 'fail')
        dumpTrace(flowMark, `failed: ${task.name}`);
    });
    beforeAll(async () => {
      invocation = await openBed();
    });
    afterAll(() => closeBed(invocation));

    for (const [mode, orientations] of Object.entries(ORIENTATIONS)) {
      describe.each(orientations)(
        `${mode}: requests from %s, answers on %s`,
        (requesterKind, responderKind) => {
          const parties = {};
          const secrets = { alice: {}, bob: {}, carol: {} };
          const rooms = {};
          const message = {};
          const native = mode === 'shim';
          /** Every client started here, to stop at the end. */
          const started = [];
          const start = async (kind, account, options) => {
            const party = await startVerifier(kind, account, options);
            started.push(party);
            return party;
          };

          afterAll(async () => {
            for (const party of started) await stopClient(party);
          });

          it('sets up cross-signed users: alice on two devices, bob and carol', async () => {
            const alice = await registerAndLogin('alice');
            parties.trusted = await start(
              responderKind,
              alice,
              storageOf(secrets.alice),
            );
            await crossSign(parties.trusted);
            await crypto(parties.trusted).bootstrapSecretStorage({
              createSecretStorageKey: () =>
                crypto(parties.trusted).createRecoveryKeyFromPassphrase(),
              setupNewKeyBackup: true,
            });
            for (const name of ['bob', 'carol']) {
              parties[name] = await start(
                responderKind,
                await registerAndLogin(name),
                storageOf(secrets[name]),
              );
              await crossSign(parties[name]);
            }
            // A message in a room alice's first device backs up, for the bundle case.
            rooms.backup = await encryptedRoom(parties.bob, [parties.trusted]);
            message.backedUp = await send(
              parties.bob,
              rooms.backup,
              'backed up',
            );
            await decrypted(
              parties.trusted,
              rooms.backup,
              message.backedUp,
              'the backed-up message',
            );
            parties.alice = await start(
              requesterKind,
              await login(alice),
              storageOf(secrets.alice),
            );
            await eventually(
              parties.alice,
              () => crypto(parties.alice).userHasCrossSigningKeys(),
              "alice's new device to see her identity",
            );
            expect(machineOf(parties.alice).__wbg_ptr === undefined).toBe(
              requesterKind === 'native',
            );
          }, 180_000);

          it('self-verifies a new device with SAS, and it receives the secrets', async () => {
            const { alice, trusted } = parties;
            const pair = await requestPair(alice, trusted, () =>
              crypto(alice).requestOwnUserVerification(),
            );
            expect(pair.request.isSelfVerification).toBe(true);
            expect(pair.request.initiatedByMe).toBe(true);
            expect(pair.incoming.initiatedByMe).toBe(false);
            expect(pair.incoming.otherDeviceId).toBe(alice.account.deviceId);
            const events = await runSas(pair);
            expect(pair.phases).toEqual({ request: FLOW, incoming: FLOW });
            expect(events).toEqual({
              request: [VerifierEvent.ShowSas],
              incoming: [VerifierEvent.ShowSas],
            });
            await eventually(
              trusted,
              async () =>
                (await deviceStatus(trusted, alice))?.crossSigningVerified,
              'the trusted device to see the new one cross-signed',
            );
            await eventually(
              alice,
              async () =>
                (await deviceStatus(alice, alice))?.crossSigningVerified,
              'the new device to see itself cross-signed',
            );
            // Gossip: the new device asked for the private keys and the backup key.
            await until(async () => {
              const { privateKeysCachedLocally: keys } =
                await crypto(alice).getCrossSigningStatus();
              return (
                keys.masterKey && keys.selfSigningKey && keys.userSigningKey
              );
            }, 'the cross-signing keys on the new device');
            await until(
              async () =>
                (await crypto(alice).getSessionBackupPrivateKey()) !== null,
              'the backup key on the new device',
            );
            expect(await crypto(alice).getSessionBackupPrivateKey()).toEqual(
              await crypto(trusted).getSessionBackupPrivateKey(),
            );
            // A flow that is over and collected answers "nothing to send", as on WASM.
            const syncs = alice.network.syncs;
            await until(() => alice.network.syncs >= syncs + 2, 'two syncs');
            await pair.request.cancel();
            expect(pair.request.phase).toBe(Done);
          }, 120_000);

          it('verifies another user with SAS in a DM', async () => {
            const { alice, bob } = parties;
            rooms.dm = await encryptedRoom(alice, [bob]);
            const pair = await requestPair(alice, bob, () =>
              crypto(alice).requestVerificationDM(bob.account.userId, rooms.dm),
            );
            expect(pair.request.roomId).toBe(rooms.dm);
            expect(pair.incoming.roomId).toBe(rooms.dm);
            expect(pair.request.isSelfVerification).toBe(false);
            const events = await runSas(pair);
            expect(pair.phases).toEqual({ request: FLOW, incoming: FLOW });
            expect(events.request).toEqual([VerifierEvent.ShowSas]);
            for (const [viewer, subject] of [
              [alice, bob],
              [bob, alice],
            ]) {
              await eventually(
                viewer,
                async () =>
                  (
                    await crypto(viewer).getUserVerificationStatus(
                      subject.account.userId,
                    )
                  ).isCrossSigningVerified(),
                `${viewer.account.userId} to see ${subject.account.userId} verified`,
              );
            }
          }, 120_000);

          for (const [title, showerSide] of [
            ['the trusted device shows the QR code', 'incoming'],
            ['the new device shows the QR code', 'request'],
          ]) {
            it(`self-verifies a new device with QR: ${title}`, async () => {
              const { trusted } = parties;
              const fresh = await start(
                requesterKind,
                await login(trusted.account),
                storageOf(secrets.alice),
              );
              await eventually(
                fresh,
                () => crypto(fresh).userHasCrossSigningKeys(),
                'the new device to see its identity',
              );
              const pair = await requestPair(fresh, trusted, () =>
                crypto(fresh).requestOwnUserVerification(),
              );
              await runQr(pair, showerSide);
              expect(pair.phases).toEqual({ request: FLOW, incoming: FLOW });
              await eventually(
                trusted,
                async () =>
                  (await deviceStatus(trusted, fresh))?.crossSigningVerified,
                'the trusted device to see the new one cross-signed',
              );
              await eventually(
                fresh,
                async () =>
                  (await deviceStatus(fresh, trusted))?.crossSigningVerified,
                'the new device to trust the other',
              );
            }, 120_000);
          }

          it('verifies another user with QR in a DM', async () => {
            const { alice, carol } = parties;
            rooms.carol = await encryptedRoom(alice, [carol]);
            const pair = await requestPair(alice, carol, () =>
              crypto(alice).requestVerificationDM(
                carol.account.userId,
                rooms.carol,
              ),
            );
            await runQr(pair, 'incoming');
            expect(pair.phases).toEqual({ request: FLOW, incoming: FLOW });
            for (const [viewer, subject] of [
              [alice, carol],
              [carol, alice],
            ]) {
              await eventually(
                viewer,
                async () =>
                  (
                    await crypto(viewer).getUserVerificationStatus(
                      subject.account.userId,
                    )
                  ).isCrossSigningVerified(),
                `${viewer.account.userId} to see ${subject.account.userId} verified`,
              );
            }
          }, 120_000);

          // Diagnosis: `NATIVE_CRYPTO_REPEAT=<n>` self-verifies n new devices in turn (SAS, QR shown
          // by the new device, QR shown by the trusted one; `NATIVE_CRYPTO_REPEAT_FLOWS` picks).
          it.runIf(process.env.NATIVE_CRYPTO_REPEAT)(
            'self-verifies new devices again and again',
            async () => {
              const { trusted } = parties;
              const flows = (
                process.env.NATIVE_CRYPTO_REPEAT_FLOWS ?? 'sas,request,incoming'
              ).split(',');
              for (
                let round = 0;
                round < Number(process.env.NATIVE_CRYPTO_REPEAT);
                round++
              ) {
                const flow = flows[round % flows.length];
                const fresh = await startVerifier(
                  requesterKind,
                  await login(trusted.account),
                  storageOf(secrets.alice),
                );
                await eventually(
                  fresh,
                  () => crypto(fresh).userHasCrossSigningKeys(),
                  'the new device to see its identity',
                );
                const pair = await requestPair(fresh, trusted, () =>
                  crypto(fresh).requestOwnUserVerification(),
                );
                if (flow === 'sas') await runSas(pair);
                else await runQr(pair, flow);
                console.log(`round ${round} ${flow} done`);
                await stopClient(fresh);
                await deleteDevice(fresh.account, fresh.account.deviceId);
              }
            },
            24 * 3_600_000,
          );

          const STAGES = ['requested', 'ready', 'started', 'shown'];
          it('cancels at every stage from either side, with code and reason on both ends', async () => {
            const { alice, bob } = parties;
            const cases = [
              ...STAGES.flatMap((stage) =>
                ['request', 'incoming'].map((side) => [stage, side, 'cancel']),
              ),
              ['shown', 'incoming', 'mismatch'],
            ];
            for (const [stage, side, how] of cases) {
              const what = `${how} by the ${side} at ${stage}`;
              const pair = await requestPair(alice, bob, () =>
                crypto(alice).requestDeviceVerification(
                  bob.account.userId,
                  bob.account.deviceId,
                ),
              );
              const canceller = side === 'request' ? alice : bob;
              const verifiers = {};
              const outcome = {};
              if (stage !== 'requested') {
                await pair.incoming.accept();
                await phaseIs(pair.request, Ready, what);
              }
              if (stage === 'started' || stage === 'shown') {
                verifiers.request =
                  await pair.request.startVerification('m.sas.v1');
                await phaseIs(pair.incoming, Started, what);
                verifiers.incoming = pair.incoming.verifier;
                for (const key of ['request', 'incoming'])
                  outcome[key] = verifiers[key].verify().then(
                    () => 'done',
                    (error) => error.message,
                  );
              }
              if (stage === 'requested' || stage === 'ready') {
                await pair[side].cancel();
              } else if (stage === 'started') {
                verifiers[side].cancel();
              } else {
                const [mine, theirs] = await Promise.all([
                  sasOf(verifiers.request),
                  sasOf(verifiers.incoming),
                ]);
                (side === 'request' ? mine : theirs)[how]();
              }
              const code = how === 'mismatch' ? 'm.mismatched_sas' : 'm.user';
              for (const key of ['request', 'incoming']) {
                await phaseIs(pair[key], Cancelled, `${what} (${key})`);
                expect(pair[key].cancellationCode, what).toBe(code);
                expect(pair[key].cancellingUserId, what).toBe(
                  canceller.account.userId,
                );
                expect(pair.phases[key].at(-1), what).toBe(Cancelled);
              }
              if (outcome.request) {
                const messages = {
                  request: await outcome.request,
                  incoming: await outcome.incoming,
                };
                for (const key of ['request', 'incoming']) {
                  const by = key === side ? 'us' : 'them';
                  expect(messages[key], what).toMatch(
                    new RegExp(
                      `^Verification cancelled by ${by} with code ${code}: .+`,
                    ),
                  );
                }
                // Both ends report the same reason.
                expect(messages.request.split(': ')[1], what).toBe(
                  messages.incoming.split(': ')[1],
                );
              }
            }
          }, 300_000);

          it('counts down the time limit on both ends', async () => {
            const { alice, bob } = parties;
            const pair = await requestPair(alice, bob, () =>
              crypto(alice).requestDeviceVerification(
                bob.account.userId,
                bob.account.deviceId,
              ),
            );
            const first = [pair.request.timeout, pair.incoming.timeout];
            for (const timeout of first) {
              expect(timeout).toBeGreaterThan(500_000);
              expect(timeout).toBeLessThanOrEqual(600_000);
            }
            await new Promise((done) => setTimeout(done, 1500));
            const later = [pair.request.timeout, pair.incoming.timeout];
            for (const [index, timeout] of later.entries()) {
              expect(first[index] - timeout).toBeGreaterThanOrEqual(1000);
              expect(first[index] - timeout).toBeLessThan(10_000);
            }
            expect(pair.request.pending).toBe(true);
            for (const [viewer, other, request] of [
              [alice, bob, pair.request],
              [bob, alice, pair.incoming],
            ]) {
              expect(
                crypto(viewer)
                  .getVerificationRequestsToDeviceInProgress(
                    other.account.userId,
                  )
                  .map((found) => found.transactionId),
              ).toEqual([request.transactionId]);
            }
            await pair.request.cancel();
            await phaseIs(pair.incoming, Cancelled, 'the responder');
          });

          it('cancels both requests when a second one arrives while the first is pending', async () => {
            const { alice, bob } = parties;
            const start = () =>
              crypto(alice).requestDeviceVerification(
                bob.account.userId,
                bob.account.deviceId,
              );
            const first = await requestPair(alice, bob, start);
            const second = await requestPair(alice, bob, start);
            expect(second.request.transactionId).not.toBe(
              first.request.transactionId,
            );
            // matrix-sdk-crypto cancels both when one user has two requests going at once.
            // Each side cancels both itself, as WASM does.
            for (const pair of [first, second]) {
              for (const [key, by] of [
                ['request', alice],
                ['incoming', bob],
              ]) {
                await phaseIs(pair[key], Cancelled, `the ${key} side`);
                expect(pair[key].cancellationCode).toBe('m.user');
                expect(pair[key].cancellingUserId).toBe(by.account.userId);
              }
            }
            expect(
              crypto(bob).getVerificationRequestsToDeviceInProgress(
                alice.account.userId,
              ),
            ).toEqual([]);
            expect(
              crypto(alice).getVerificationRequestsToDeviceInProgress(
                bob.account.userId,
              ),
            ).toEqual([]);
          }, 120_000);

          it.skipIf(!native)(
            'sees a request that arrived while the shim client was offline',
            async () => {
              // A new user: a client started again without a sync token gets the timeline again,
              // and an old in-room request from the same user in it would cancel the new one
              // upstream (on either backend).
              const offline = await start(
                'native',
                await registerAndLogin('dave'),
              );
              const requester =
                parties.alice.kind === 'wasm' ? parties.alice : parties.bob;
              // A room without verification events in it, so both track each other's devices.
              await encryptedRoom(requester, [offline]);
              await knows(offline, requester);
              await knows(requester, offline);
              await stopClient(offline);
              const request = await crypto(requester).requestDeviceVerification(
                offline.account.userId,
                offline.account.deviceId,
              );
              const back = await startClient('native', offline.account, {
                storeKey: offline.storeKey,
              });
              started.push(back);
              const seen = await until(
                () =>
                  crypto(back)
                    .getVerificationRequestsToDeviceInProgress(
                      requester.account.userId,
                    )
                    .find(
                      (found) => found.transactionId === request.transactionId,
                    ),
                'the request on the restarted client',
              );
              expect(seen.phase).toBe(Requested);
              const phases = { request: track(request), incoming: track(seen) };
              await runSas({ request, incoming: seen });
              expect(phases).toEqual({ request: FLOW, incoming: FLOW });
            },
            120_000,
          );

          it('moves a secrets bundle to a new device, with cross-signing and backup working', async () => {
            const { trusted } = parties;
            const bundle = await crypto(trusted).exportSecretsBundle();
            expect(Object.keys(bundle).sort()).toEqual([
              'backup',
              'cross_signing',
            ]);
            const fresh = await start(
              requesterKind,
              await login(trusted.account),
            );
            await until(
              () => fresh.client.getRoom(rooms.backup),
              'the backed-up room on the new device',
            );
            await undecryptable(
              fresh,
              rooms.backup,
              message.backedUp,
              'a message from before it',
            );
            await crypto(fresh).importSecretsBundle(bundle);
            const status = await crypto(fresh).getCrossSigningStatus();
            expect(status.privateKeysCachedLocally).toEqual({
              masterKey: true,
              selfSigningKey: true,
              userSigningKey: true,
            });
            // As QR sign-in does (auth.service.ts, importLinkedSecrets).
            await crypto(fresh).crossSignDevice(fresh.account.deviceId);
            await eventually(
              fresh,
              () => crypto(fresh).isCrossSigningReady(),
              'the new device to be cross-signing ready',
            );
            await eventually(
              trusted,
              async () =>
                (await deviceStatus(trusted, fresh))?.crossSigningVerified,
              'the other device to see the new one cross-signed',
            );
            expect(await crypto(fresh).getSessionBackupPrivateKey()).toEqual(
              await crypto(trusted).getSessionBackupPrivateKey(),
            );
            const backup = await crypto(fresh).checkKeyBackupAndEnable();
            expect(backup?.trustInfo.trusted).toBe(true);
            await crypto(fresh).restoreKeyBackup();
            await decrypted(
              fresh,
              rooms.backup,
              message.backedUp,
              'the message restored from the backup',
            );
          }, 120_000);

          it('shares room history on invite (MSC4268), both ways', async () => {
            const { alice, bob } = parties;
            for (const [inviter, invitee] of [
              [alice, bob],
              [bob, alice],
            ]) {
              const { room_id: roomId } = await inviter.client.createRoom({
                initial_state: [
                  {
                    type: 'm.room.encryption',
                    state_key: '',
                    content: { algorithm: 'm.megolm.v1.aes-sha2' },
                  },
                  {
                    type: 'm.room.history_visibility',
                    state_key: '',
                    content: { history_visibility: 'shared' },
                  },
                ],
              });
              await until(
                () => inviter.client.getRoom(roomId)?.hasEncryptionStateEvent(),
                'the room encrypted',
              );
              const earlier = await send(inviter, roomId, 'history');
              await inviter.client.invite(roomId, invitee.account.userId);
              await until(() => invitee.client.getRoom(roomId), 'the invite');
              await invitee.client.joinRoom(roomId);
              await joined(inviter, roomId, invitee.account.userId);
              await until(async () => {
                const room = invitee.client.getRoom(roomId);
                if (room.findEventById(earlier)) return true;
                await invitee.client.scrollback(room, 20);
                return false;
              }, 'the earlier message in the timeline');
              await decrypted(
                invitee,
                roomId,
                earlier,
                `history shared by ${inviter.kind}`,
                60_000,
              );
            }
          }, 180_000);

          it('rehydrates a dehydrated device the shim made, on both backends', async () => {
            const maker =
              mode === 'control' || parties.alice.kind === 'native'
                ? parties.alice
                : parties.trusted;
            expect(await crypto(maker).isDehydrationSupported()).toBe(true);
            await crypto(maker).startDehydration();
            const { bob } = parties;
            let previous;
            for (const kind of native ? ['native', 'wasm'] : ['wasm', 'wasm']) {
              const dehydrated = await eventually(
                bob,
                async () => {
                  const devices = await crypto(bob).getUserDeviceInfo(
                    [maker.account.userId],
                    true,
                  );
                  return [...devices.get(maker.account.userId).values()].find(
                    (device) =>
                      device.dehydrated && device.deviceId !== previous,
                  );
                },
                'bob to see the dehydrated device',
              );
              await crypto(bob).forceDiscardSession(rooms.backup);
              const sent = await send(
                bob,
                rooms.backup,
                `while offline ${kind}`,
              );
              const fresh = await start(
                kind,
                await login(maker.account),
                storageOf(secrets.alice),
              );
              previous = dehydrated.deviceId;
              const progress = [];
              for (const name of [
                CryptoEvent.RehydrationStarted,
                CryptoEvent.RehydrationProgress,
                CryptoEvent.RehydrationCompleted,
                CryptoEvent.RehydrationError,
              ])
                fresh.client.on(name, (...args) =>
                  progress.push([
                    name,
                    ...args.filter((arg) => typeof arg !== 'object'),
                  ]),
                );
              await eventually(
                fresh,
                () => crypto(fresh).userHasCrossSigningKeys(),
                'the new login to see its identity',
              );
              await crypto(fresh).bootstrapCrossSigning({});
              await crypto(fresh).startDehydration({ rehydrate: true });
              expect(progress.at(-1)?.[0], JSON.stringify(progress)).toBe(
                CryptoEvent.RehydrationCompleted,
              );
              await decrypted(
                fresh,
                rooms.backup,
                sent,
                `a message for the dehydrated device ${dehydrated.deviceId}`,
                60_000,
              );
            }
          }, 240_000);
        },
      );
    }

    // The waits for each device to know the other must not hide slower key queries on native.
    it('learns another device as fast on native as on WASM, within a generous bound', () => {
      if (learning.native.length === 0 || learning.wasm.length === 0) return;
      const slowest = (times) => Math.max(...times);
      expect(slowest(learning.native)).toBeLessThan(
        Math.max(5_000, 5 * slowest(learning.wasm)),
      );
    });
  },
);
