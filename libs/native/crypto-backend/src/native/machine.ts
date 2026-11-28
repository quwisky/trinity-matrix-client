import {
  BackupDecryptionKey,
  type BackupKeys,
  type CollectStrategy,
  type CrossSigningBootstrapRequests,
  type CrossSigningKeyExport,
  type CrossSigningStatus,
  type DecryptedRoomEvent,
  type DecryptionSettings,
  DeviceId,
  type Device,
  type DeviceLists,
  type DehydratedDevices,
  EncryptedAttachment,
  EncryptionAlgorithm,
  type EncryptionInfo,
  type EncryptionSettings,
  type IdentityKeys,
  type KeysBackupRequest,
  type KeysClaimRequest,
  type KeysQueryRequest,
  OlmMachine,
  type OtherUserIdentity,
  type OutgoingRequest,
  type OwnUserIdentity,
  type ProcessedToDeviceEvent,
  RequestType,
  type RoomKeyInfo,
  type RoomKeyWithheldInfo,
  type RoomId,
  type RoomKeyCounts,
  type RoomKeyImportResult,
  type RoomPendingKeyBundleDetails,
  type RoomSettings,
  type SecretsBundle,
  type Signatures,
  type SignatureVerification,
  StoreHandle,
  type StoredRoomKeyBundleData,
  type ToDeviceRequest,
  type UserDevices,
  UserId,
  type VerificationRequest,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import type { CallQueue } from './call-queue';
import {
  base64ToBytes,
  type BundleDataJson,
  bytesToBase64,
  type CrossSigningKeyExportJson,
  type CrossSigningStatusJson,
  encryptionSettingsJson,
  type EncryptionInfoJson,
  type ImportResultJson,
  isBootstrapRequests,
  isBundleData,
  isCrossSigningKeyExport,
  isCrossSigningStatus,
  isImportResult,
  isSecretsBundle,
  type MegolmErrorDetails,
  NativeSecretsBundle,
  type RequestJson,
  roomSettingsJson,
  strategyName,
  type RoomSettingsJson,
  toBootstrapRequests,
  toBundleData,
  toCrossSigningKeyExport,
  toCrossSigningStatus,
  toDecryptedRoomEvent,
  toEncryptionInfo,
  toIdentityKeys,
  toImportResult,
  toMegolmDecryptionError,
  type PendingBundleJson,
  toPendingBundle,
  toProcessedToDeviceEvent,
  toRequest,
  toRoomKeyCounts,
  toRoomKeyInfo,
  toRoomKeyWithheldInfo,
  toRoomSettings,
  toSignatures,
  toSignatureVerification,
} from './convert';
import { NativeDehydratedDevices } from './dehydrated';
import { standIn } from './guard';
import {
  type DeviceJson,
  type IdentityJson,
  isDevice,
  isIdentity,
  type MachineCall,
  NativeBackupKeys,
  NativeDevice,
  NativeUserDevices,
  toIdentity,
} from './trust';
import {
  checked,
  describeError,
  isObject,
  NativeBridgeError,
  NativeCryptoError,
  type NativeCryptoLogger,
  type NativeEvents,
  NativeMachineLostError,
} from './types';
import { Verifications } from './verification';

/** What `init` opens: a SQLite store with its raw key, or memory. */
export class NativeStoreHandle {
  #store: { storePath: string; storeKey: string } | undefined;

  public constructor(store?: { storePath: string; storeKey: string }) {
    this.#store = store;
  }

  /** The `init` parameters; the key is handed out once, to the machine that keeps it for a re-init. */
  public take(): Record<string, string> {
    const store = this.#store;
    this.#store = undefined;
    return store ?? {};
  }

  public free(): void {
    this.#store = undefined;
  }
}
standIn(NativeStoreHandle, StoreHandle);

interface MachineDescription {
  readonly userId: string;
  readonly deviceId: string;
  readonly identityKeys: {
    readonly ed25519: string;
    readonly curve25519: string;
  };
  readonly deviceCreationTimeMs: number;
}

interface MachineContext {
  readonly queue: CallQueue;
  readonly logger?: NativeCryptoLogger;
  readonly onEventsDropped?: (dropped: number | undefined) => void;
  readonly onMachineLost?: (reason: string) => void;
}

/** The crate dropped the machine (a panic, or a call after one): `init` reloads it from the store. */
const DROPPED = new Set(['Panic', 'UnknownMachine']);

/**
 * Calls replayed once on the reloaded machine after the crate dropped it. Their answer never
 * reached JavaScript, so nothing they produced (a request, a ciphertext) was used; each one only
 * reads, or sets state to the same value again. A replayed sync input is safe too: what the store
 * kept is kept, an Olm message it already decrypted comes back as undecryptable without harm
 * (scripts/native-crypto-replay.test.mjs), and one-time key counts and device lists are absolute.
 * Not replayed: calls whose half-done effect a replay could apply twice or wrongly —
 * `markRequestAsSent` (the sent request belonged to the dropped machine; the reloaded one builds
 * it again), `shareRoomKey`, `encryptRoomEvent`, `encryptStateEvent` and `invalidateGroupSession`
 * (session state; matrix-js-sdk retries the send), `encryptToDeviceEvent` (the same, for an
 * Olm session), `bootstrapCrossSigning` (each run makes new keys; matrix-js-sdk's bootstrap
 * fails and is run again) — and `close`.
 */
const REPLAYABLE = new Set([
  'receiveSyncChanges',
  'receiveSyncChangesMsc4186',
  'outgoingRequests',
  'updateTrackedUsers',
  'trackedUsers',
  'markAllTrackedUsersAsDirty',
  'getMissingSessions',
  'queryKeysForUsers',
  'decryptRoomEvent',
  'getRoomEventEncryptionInfo',
  'getRoomSettings',
  'setRoomSettings',
  'getIdentity',
  'isBackupEnabled',
  'getSecretsFromInbox',
  'deleteSecretsFromInbox',
  'getAllRoomsPendingKeyBundles',
  'getPendingKeyBundleDetailsForRoom',
  'storeRoomPendingKeyBundle',
  'clearRoomPendingKeyBundle',
  'getReceivedRoomKeyBundleData',
  'roomKeyRequestsEnabled',
  // Reads of devices, identities, keys and backup state.
  'getDevice',
  'getUserDevices',
  'crossSigningStatus',
  'exportCrossSigningKeys',
  'exportRoomKeys',
  'roomKeyCounts',
  'getBackupKeys',
  'verifyBackup',
  // Deterministic, nothing sent: an ed25519 signature of the same message.
  'sign',
  'verifyDevice',
  'verifyIdentity',
  // Set state to an absolute value; the trust calls carry the key their object was read with.
  'setLocalTrust',
  'withdrawVerification',
  'pinCurrentMasterKey',
  'importCrossSigningKeys',
  'saveBackupDecryptionKey',
  'enableBackupV1',
  'disableBackup',
  // Nothing sent yet: the reloaded machine builds the request again.
  'backupRoomKeys',
  // Queues the pushes in memory only (upstream's gossip queue), which the drop discarded, so the
  // replay queues each push once.
  'pushSecretToVerifiedDevices',
  // Keys already imported are skipped (the replay reports fewer new ones).
  'importExportedRoomKeys',
  'importBackedUpRoomKeys',
  'importSecretsBundle',
  'receiveRoomKeyBundle',
  // Verification reads; a reload drops every flow (the registry is cleared), so a replay finds
  // none. Calls that send or advance a flow are not replayed: requesting, accepting, starting,
  // scanning, confirming, cancelling and an in-room verification event.
  'getVerificationRequest',
  'getVerificationRequests',
  'getVerification',
  'qrCodeBytes',
  'verificationRequestContent',
  // Reads, absolute setters, and calls whose result never reached JavaScript: the bundle and the
  // dehydrated device a replay builds again were never uploaded, and a rehydration is held in
  // memory only. Not replayed: `shareRoomKeyBundleData` (Olm encryption, as the encrypt calls)
  // and `receiveRehydratedEvents` (the reload dropped the rehydrated device it needs).
  'exportSecretsBundle',
  'buildRoomKeyBundle',
  'hasDownloadedAllRoomKeys',
  'setHasDownloadedAllRoomKeys',
  'createDehydratedDevice',
  'getDehydratedDeviceKey',
  'saveDehydratedDeviceKey',
  'rehydrateDevice',
  'dropRehydratedDevice',
]);

/** Sessions remembered for a retry after lost events; the oldest go first past this many. */
const UNDECRYPTABLE_LIMIT = 1000;

type RoomKeyJson = Parameters<typeof toRoomKeyInfo>[0];

/** The sender and flow of an incoming verification request, if `event` is one. */
function incomingRequest(
  event: string,
): { userId: string; flowId: string } | undefined {
  try {
    const parsed = JSON.parse(event) as {
      type?: unknown;
      sender?: unknown;
      event_id?: unknown;
      content?: { msgtype?: unknown; transaction_id?: unknown };
    };
    const flowId =
      parsed.type === 'm.key.verification.request'
        ? parsed.content?.transaction_id
        : parsed.type === 'm.room.message' &&
            parsed.content?.msgtype === 'm.key.verification.request'
          ? parsed.event_id
          : undefined;
    return typeof flowId === 'string' && typeof parsed.sender === 'string'
      ? { userId: parsed.sender, flowId }
      : undefined;
  } catch {
    return undefined;
  }
}

const isShield = (value: unknown) =>
  isObject(value) && typeof value['color'] === 'number';
const isEncryptionInfo = (value: unknown) =>
  isObject(value) &&
  typeof value['sender'] === 'string' &&
  typeof value['senderCurve25519Key'] === 'string' &&
  isObject(value['shieldState']) &&
  isShield(value['shieldState']['lax']) &&
  isShield(value['shieldState']['strict']);
const isDescription = (value: unknown) =>
  isObject(value) &&
  typeof value['userId'] === 'string' &&
  typeof value['deviceId'] === 'string' &&
  isObject(value['identityKeys']) &&
  typeof value['identityKeys']['ed25519'] === 'string' &&
  typeof value['identityKeys']['curve25519'] === 'string' &&
  typeof value['deviceCreationTimeMs'] === 'number';

/** A processed to-device event as the crate answers it (`ProcessedToDeviceEventType` 0–3). */
const isToDeviceEvent = (value: unknown) =>
  isObject(value) &&
  typeof value['rawEvent'] === 'string' &&
  (value['type'] === 0
    ? isObject(value['encryptionInfo']) &&
      typeof value['encryptionInfo']['sender'] === 'string' &&
      typeof value['encryptionInfo']['senderCurve25519Key'] === 'string' &&
      typeof value['encryptionInfo']['isSenderVerified'] === 'boolean'
    : value['type'] === 1
      ? isObject(value['utdInfo'])
      : value['type'] === 2 || value['type'] === 3);

/** A sync input on a lost machine: never settles, so matrix-js-sdk never moves past it. */
const forever = <T>(): Promise<T> => new Promise<T>(() => undefined);

type Callback = (...args: never[]) => unknown;

/**
 * `OlmMachine` on the native crate. The constants are read once at `init`; every other
 * member is a call through the queue. Members not here throw (see guard.ts).
 */
export class NativeOlmMachine {
  readonly #context: MachineContext;
  readonly #description: MachineDescription;
  /** The `init` parameters for a reload, store key included, until the machine is closed or lost. */
  #store: Record<string, string> | undefined;
  #roomKeyRequestsEnabled: boolean;
  readonly #callbacks = new Map<string, Callback>();
  #recovery: Promise<void> | undefined;
  /** Calls waiting on `#recovery` that have not enqueued yet. */
  #waiting = 0;
  #lost = false;
  #closed = false;
  /** How the device and identity stand-ins call: through this machine's reload and loss rules. */
  readonly #objectCall: MachineCall = (method, params) =>
    this.#call(method, params);
  readonly #verifications: Verifications;
  /** Megolm sessions that failed to decrypt, by room and session, for a retry after lost events. */
  readonly #undecryptable = new Map<string, RoomKeyJson>();

  private constructor(
    context: MachineContext,
    description: MachineDescription,
    store: Record<string, string>,
    roomKeyRequestsEnabled: boolean,
  ) {
    this.#context = context;
    this.#description = description;
    this.#store = store;
    this.#roomKeyRequestsEnabled = roomKeyRequestsEnabled;
    this.#verifications = new Verifications(this.#objectCall, context.logger);
    context.queue.listen(
      description,
      (events) => this.#deliver(events),
      (reason, malformed) => {
        this.#context.logger?.warn(reason);
        this.#context.onEventsDropped?.(undefined);
        if (malformed) this.#lose(reason);
        else this.#resync();
      },
    );
  }

  public static async init(
    context: MachineContext,
    userId: UserId,
    deviceId: DeviceId,
    store: NativeStoreHandle,
  ): Promise<NativeOlmMachine> {
    const ids = { userId: userId.toString(), deviceId: deviceId.toString() };
    const params = store.take();
    const [description, enabled] = await Promise.all([
      context.queue.call({ method: 'init', ...ids, params }),
      context.queue.call({ method: 'roomKeyRequestsEnabled', ...ids }),
    ]);
    return new NativeOlmMachine(
      context,
      checked('init', description, isDescription),
      params,
      checked(
        'roomKeyRequestsEnabled',
        enabled,
        (value) => typeof value === 'boolean',
      ),
    );
  }

  #send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const { userId, deviceId } = this.#description;
    return this.#context.queue.call({
      method,
      userId,
      deviceId,
      ...(params ? { params } : {}),
    });
  }

  /**
   * A call; when the crate dropped the machine it is reloaded with `init` and a replayable
   * call runs once more. A bridge failure, a failed reload or a second drop loses the machine.
   */
  async #call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.#lost) throw new NativeMachineLostError(method);
    const send = () => this.#send(method, params);
    try {
      // A reload in flight goes first, then the replays it holds, then this call.
      return await (this.#recovery
        ? this.#afterRecovery(method, send)
        : send());
    } catch (error) {
      if (!this.#isDropped(error)) throw this.#failure(method, error);
      this.#recover(method);
      if (!REPLAYABLE.has(method)) {
        await this.#afterRecovery(method, () => Promise.reject(error));
      }
      try {
        return await this.#afterRecovery(method, send);
      } catch (again) {
        if (this.#isDropped(again))
          this.#lose(`${method} dropped the machine again after a re-init`);
        throw this.#failure(method, again);
      }
    }
  }

  #isDropped(error: unknown): boolean {
    return (
      !this.#closed &&
      !this.#lost &&
      error instanceof NativeCryptoError &&
      DROPPED.has(error.code)
    );
  }

  /** What a failed call throws: a bridge failure loses the machine. */
  #failure(method: string, error: unknown): unknown {
    if (error instanceof NativeBridgeError) this.#lose(error.message);
    return this.#lost ? new NativeMachineLostError(method) : error;
  }

  /**
   * Runs `run` once the reload in flight is done. `run` enqueues its call before this returns
   * control, and the reload counts as in flight until every call waiting on it has enqueued, so
   * nothing made meanwhile can pass a replay.
   */
  async #afterRecovery(
    method: string,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const recovery = this.#recovery;
    if (!recovery) return run();
    this.#waiting++;
    let result: Promise<unknown> | undefined;
    try {
      await recovery;
      if (this.#lost) throw new NativeMachineLostError(method);
      result = run();
    } finally {
      if (--this.#waiting === 0 && this.#recovery === recovery)
        this.#recovery = undefined;
    }
    return result;
  }

  /** Starts a reload unless one is in flight; a lost or closed machine has nothing to reload. */
  #recover(method: string): void {
    const store = this.#store;
    if (this.#lost || !store) return;
    this.#recovery ??= (async () => {
      this.#context.logger?.warn(
        `native crypto ${method}: the crate dropped the machine; reloading it`,
      );
      try {
        const [description] = await Promise.all([
          this.#send('init', store),
          this.#send('roomKeyRequestsEnabled', {
            enabled: this.#roomKeyRequestsEnabled,
          }),
        ]);
        const keys = checked<MachineDescription>(
          'init',
          description,
          isDescription,
        ).identityKeys;
        if (
          keys.ed25519 !== this.#description.identityKeys.ed25519 ||
          keys.curve25519 !== this.#description.identityKeys.curve25519
        ) {
          throw new Error('the store holds another account');
        }
        // Verifications live in the dropped machine's memory only.
        this.#verifications.clear();
      } catch (error) {
        this.#lose(
          `init could not reload the machine: ${describeError(error)}`,
        );
      }
    })();
  }

  #lose(reason: string): void {
    if (this.#lost || this.#closed) return;
    this.#lost = true;
    this.#store = undefined;
    this.#verifications.clear();
    this.#context.queue.unlisten(this.#description);
    this.#context.logger?.warn(`native crypto lost the machine: ${reason}`);
    this.#context.onMachineLost?.(reason);
  }

  /** Runs a call nobody awaits (WASM's member is synchronous) and reports its failure. */
  #detach(
    method: string,
    params?: Record<string, unknown>,
    failed?: () => void,
  ): void {
    this.#call(method, params).catch((error: unknown) => {
      failed?.();
      this.#context.logger?.warn(
        `native crypto ${method} failed: ${describeError(error)}`,
      );
    });
  }

  #invoke(name: string, ...args: unknown[]): void {
    const callback = this.#callbacks.get(name) as
      ((...values: unknown[]) => unknown) | undefined;
    if (!callback) return;
    try {
      Promise.resolve(callback(...args)).catch((error: unknown) =>
        this.#context.logger?.warn(
          `native crypto ${name} callback failed: ${describeError(error)}`,
        ),
      );
    } catch (error) {
      this.#context.logger?.warn(
        `native crypto ${name} callback failed: ${describeError(error)}`,
      );
    }
  }

  #deliver({ events, dropped }: NativeEvents): void {
    for (const event of events) {
      switch (event.type) {
        case 'roomKeysReceived': {
          const keys = event['keys'] as RoomKeyJson[];
          // matrix-js-sdk retries these sessions itself now.
          for (const key of keys)
            this.#undecryptable.delete(sessionKey(key.roomId, key.sessionId));
          this.#invoke('roomKeysReceived', keys.map(toRoomKeyInfo));
          break;
        }
        case 'roomKeysWithheld':
          this.#invoke(
            'roomKeysWithheld',
            (
              event['keys'] as Parameters<typeof toRoomKeyWithheldInfo>[0][]
            ).map(toRoomKeyWithheldInfo),
          );
          break;
        case 'userIdentityUpdated':
          this.#invoke(
            'userIdentityUpdated',
            new UserId(event['userId'] as string),
          );
          break;
        case 'devicesUpdated':
          this.#invoke('devicesUpdated', event['userIds']);
          break;
        case 'secretReceived':
          // matrix-js-sdk ignores the value and reads the inbox; the crate never sends it.
          this.#invoke('secretReceived', event['name'], '');
          break;
        case 'verificationRequestChanged':
          this.#verifications.requestChanged(event['request']);
          break;
        case 'verificationChanged':
          this.#verifications.verificationChanged(event['verification']);
          break;
        default:
          this.#context.logger?.warn(
            `native crypto event ${event.type} has no handler on native yet`,
          );
      }
    }
    if (dropped > 0) {
      this.#context.logger?.warn(
        `native crypto dropped ${dropped} events: retrying undecryptable events and reading verifications again`,
      );
      this.#context.onEventsDropped?.(dropped);
      this.#resync();
    }
  }

  /**
   * After lost events (a room key, a verification change): matrix-js-sdk retries the events of
   * every session that failed to decrypt, through the room key callback it retries a session's
   * events from, and each verification mirror reads its object again.
   */
  #resync(): void {
    const sessions = [...this.#undecryptable.values()];
    this.#undecryptable.clear();
    if (sessions.length > 0)
      this.#invoke('roomKeysReceived', sessions.map(toRoomKeyInfo));
    void this.#verifications.refresh();
  }

  /** Remembers a session whose event did not decrypt, for `#resync`. */
  #failedToDecrypt(event: string, roomId: string): void {
    try {
      const content = (
        JSON.parse(event) as { content?: Record<string, unknown> }
      ).content;
      const sessionId = content?.['session_id'];
      if (typeof sessionId !== 'string') return;
      const senderKey = content?.['sender_key'];
      const key = sessionKey(roomId, sessionId);
      this.#undecryptable.delete(key);
      this.#undecryptable.set(key, {
        algorithm: EncryptionAlgorithm.MegolmV1AesSha2,
        roomId,
        sessionId,
        // matrix-js-sdk only logs it; the field is deprecated and may be missing.
        senderKey:
          typeof senderKey === 'string'
            ? senderKey
            : this.#description.identityKeys.curve25519,
      });
      if (this.#undecryptable.size > UNDECRYPTABLE_LIMIT) {
        this.#undecryptable.delete(this.#undecryptable.keys().next().value!);
      }
    } catch {
      // Not JSON: matrix-js-sdk would not have it pending either.
    }
  }

  /** Puts an incoming request in the registry: matrix-js-sdk asks for it synchronously next. */
  async #fetchRequest(found: {
    userId: string;
    flowId: string;
  }): Promise<void> {
    try {
      const answer = await this.#call('getVerificationRequest', found);
      if (answer !== null) this.#verifications.request(answer);
    } catch (error) {
      this.#context.logger?.warn(
        `native crypto getVerificationRequest failed: ${describeError(error)}`,
      );
    }
  }

  public get userId(): UserId {
    return new UserId(this.#description.userId);
  }

  public get deviceId(): DeviceId {
    return new DeviceId(this.#description.deviceId);
  }

  public get identityKeys(): IdentityKeys {
    return toIdentityKeys(this.#description.identityKeys);
  }

  public get deviceCreationTimeMs(): number {
    return this.#description.deviceCreationTimeMs;
  }

  public get roomKeyRequestsEnabled(): boolean {
    return this.#roomKeyRequestsEnabled;
  }

  public set roomKeyRequestsEnabled(enabled: boolean) {
    const previous = this.#roomKeyRequestsEnabled;
    this.#roomKeyRequestsEnabled = enabled;
    this.#detach('roomKeyRequestsEnabled', { enabled }, () => {
      if (this.#roomKeyRequestsEnabled === enabled)
        this.#roomKeyRequestsEnabled = previous;
    });
  }

  public registerRoomKeyUpdatedCallback(
    callback: (info: RoomKeyInfo[]) => Promise<void>,
  ): void {
    this.#callbacks.set('roomKeysReceived', callback);
  }

  public registerRoomKeysWithheldCallback(
    callback: (info: RoomKeyWithheldInfo[]) => Promise<void>,
  ): void {
    this.#callbacks.set('roomKeysWithheld', callback);
  }

  public registerUserIdentityUpdatedCallback(
    callback: (userId: UserId) => Promise<void>,
  ): void {
    this.#callbacks.set('userIdentityUpdated', callback);
  }

  public registerDevicesUpdatedCallback(
    callback: (userIds: string[]) => Promise<void>,
  ): void {
    this.#callbacks.set('devicesUpdated', callback);
  }

  public registerReceiveSecretCallback(
    callback: (name: string, value: string) => Promise<void>,
  ): void {
    this.#callbacks.set('secretReceived', callback);
  }

  public async receiveSyncChanges(
    toDeviceEvents: string,
    changedDevices: DeviceLists,
    oneTimeKeysCounts: Map<string, number>,
    unusedFallbackKeys?: Set<string>,
    decryptionSettings?: DecryptionSettings,
  ): Promise<ProcessedToDeviceEvent[]> {
    return this.#receiveSyncChanges(
      'receiveSyncChanges',
      toDeviceEvents,
      changedDevices,
      oneTimeKeysCounts,
      unusedFallbackKeys,
      decryptionSettings,
    );
  }

  public async receiveSyncChangesMsc4186(
    toDeviceEvents: string,
    changedDevices: DeviceLists,
    oneTimeKeysCounts: Map<string, number>,
    unusedFallbackKeys?: Set<string>,
    decryptionSettings?: DecryptionSettings,
  ): Promise<ProcessedToDeviceEvent[]> {
    return this.#receiveSyncChanges(
      'receiveSyncChangesMsc4186',
      toDeviceEvents,
      changedDevices,
      oneTimeKeysCounts,
      unusedFallbackKeys,
      decryptionSettings,
    );
  }

  async #receiveSyncChanges(
    method: string,
    toDeviceEvents: string,
    changedDevices: DeviceLists,
    oneTimeKeysCounts: Map<string, number>,
    unusedFallbackKeys?: Set<string>,
    decryptionSettings?: DecryptionSettings,
  ): Promise<ProcessedToDeviceEvent[]> {
    // Upstream collects the flows that are over at the start of a sync input.
    const collectable = this.#verifications.collectable();
    let answer: unknown;
    try {
      answer = await this.#call(method, {
        toDeviceEvents,
        changedDevices: {
          changed: changedDevices.changed.map(String),
          left: changedDevices.left.map(String),
        },
        oneTimeKeysCounts: Object.fromEntries(oneTimeKeysCounts),
        ...(unusedFallbackKeys
          ? { unusedFallbackKeys: [...unusedFallbackKeys] }
          : {}),
        ...(decryptionSettings
          ? { decryptionSettings: decryptionSettingsJson(decryptionSettings) }
          : {}),
      });
    } catch (error) {
      // matrix-js-sdk logs a rejected sync input and moves on, and the server then drops the
      // to-device events it held: a lost machine leaves the sync waiting instead.
      if (this.#lost) return forever();
      throw error;
    }
    let processed: ProcessedToDeviceEvent[];
    try {
      if (!Array.isArray(answer) || !answer.every(isToDeviceEvent))
        throw new Error('unexpected shape');
      processed = (
        answer as Parameters<typeof toProcessedToDeviceEvent>[0][]
      ).map(toProcessedToDeviceEvent);
    } catch {
      // A rejection here would let matrix-js-sdk move past these events too. Never the
      // conversion's text: it may quote the answer.
      this.#lose(`${method} answered an unexpected shape`);
      return forever();
    }
    this.#verifications.drop(collectable);
    for (const event of processed) {
      const found = incomingRequest(event.rawEvent);
      if (found) await this.#fetchRequest(found);
    }
    return processed;
  }

  public async outgoingRequests(): Promise<OutgoingRequest[]> {
    return ((await this.#call('outgoingRequests')) as RequestJson[]).map(
      toRequest,
    );
  }

  public async markRequestAsSent(
    requestId: string,
    requestType: RequestType,
    response: string,
  ): Promise<true> {
    return (await this.#call('markRequestAsSent', {
      requestId,
      requestType,
      response,
    })) as true;
  }

  public async updateTrackedUsers(users: UserId[]): Promise<void> {
    await this.#call('updateTrackedUsers', { users: users.map(String) });
  }

  public async trackedUsers(): Promise<Set<UserId>> {
    return new Set(
      ((await this.#call('trackedUsers')) as string[]).map(
        (user) => new UserId(user),
      ),
    );
  }

  /** Synchronous in WASM: matrix-js-sdk awaits it through the repository's patch. */
  public async queryKeysForUsers(users: UserId[]): Promise<KeysQueryRequest> {
    return toRequest(
      (await this.#call('queryKeysForUsers', {
        users: users.map(String),
      })) as RequestJson,
    ) as KeysQueryRequest;
  }

  public async markAllTrackedUsersAsDirty(): Promise<void> {
    await this.#call('markAllTrackedUsersAsDirty');
  }

  public async getMissingSessions(
    users: UserId[],
  ): Promise<KeysClaimRequest | undefined> {
    const request = checked<RequestJson | null>(
      'getMissingSessions',
      await this.#call('getMissingSessions', { users: users.map(String) }),
      (value) =>
        value === null ||
        (isObject(value) &&
          value['type'] === RequestType.KeysClaim &&
          typeof value['id'] === 'string' &&
          typeof value['body'] === 'string'),
    );
    return request ? (toRequest(request) as KeysClaimRequest) : undefined;
  }

  public async shareRoomKey(
    roomId: RoomId,
    users: UserId[],
    encryptionSettings: EncryptionSettings,
  ): Promise<ToDeviceRequest[]> {
    const requests = (await this.#call('shareRoomKey', {
      roomId: roomId.toString(),
      users: users.map(String),
      encryptionSettings: encryptionSettingsJson(encryptionSettings),
    })) as RequestJson[];
    return requests.map(toRequest) as ToDeviceRequest[];
  }

  public async encryptRoomEvent(
    roomId: RoomId,
    eventType: string,
    content: string,
  ): Promise<string> {
    return (await this.#call('encryptRoomEvent', {
      roomId: roomId.toString(),
      eventType,
      content,
    })) as string;
  }

  public async encryptStateEvent(
    roomId: RoomId,
    eventType: string,
    stateKey: string,
    content: string,
  ): Promise<string> {
    return (await this.#call('encryptStateEvent', {
      roomId: roomId.toString(),
      eventType,
      stateKey,
      content,
    })) as string;
  }

  public async decryptRoomEvent(
    event: string,
    roomId: RoomId,
    decryptionSettings: DecryptionSettings,
  ): Promise<DecryptedRoomEvent> {
    try {
      const decrypted = await this.#call('decryptRoomEvent', {
        event,
        roomId: roomId.toString(),
        decryptionSettings: decryptionSettingsJson(decryptionSettings),
      });
      const result = toDecryptedRoomEvent(
        checked<Parameters<typeof toDecryptedRoomEvent>[0]>(
          'decryptRoomEvent',
          decrypted,
          (value) =>
            isEncryptionInfo(value) &&
            isObject(value) &&
            typeof value['event'] === 'string',
        ),
      );
      const sessionId = (
        JSON.parse(event) as { content?: { session_id?: unknown } }
      ).content?.session_id;
      if (typeof sessionId === 'string')
        this.#undecryptable.delete(sessionKey(roomId.toString(), sessionId));
      return result;
    } catch (error) {
      if (
        error instanceof NativeCryptoError &&
        error.code === 'MegolmDecryptionError'
      ) {
        this.#failedToDecrypt(event, roomId.toString());
        throw toMegolmDecryptionError(error.details as MegolmErrorDetails);
      }
      throw error;
    }
  }

  public async getRoomEventEncryptionInfo(
    event: string,
    roomId: RoomId,
  ): Promise<EncryptionInfo> {
    const info = await this.#call('getRoomEventEncryptionInfo', {
      event,
      roomId: roomId.toString(),
    });
    return toEncryptionInfo(
      checked<EncryptionInfoJson>(
        'getRoomEventEncryptionInfo',
        info,
        isEncryptionInfo,
      ),
    );
  }

  public async getRoomSettings(
    roomId: RoomId,
  ): Promise<RoomSettings | undefined> {
    const settings = checked<RoomSettingsJson | null>(
      'getRoomSettings',
      await this.#call('getRoomSettings', { roomId: roomId.toString() }),
      (value) =>
        value === null ||
        (isObject(value) &&
          typeof value['algorithm'] === 'number' &&
          typeof value['encryptStateEvents'] === 'boolean' &&
          typeof value['onlyAllowTrustedDevices'] === 'boolean'),
    );
    return settings ? toRoomSettings(settings) : undefined;
  }

  public async setRoomSettings(
    roomId: RoomId,
    roomSettings: RoomSettings,
  ): Promise<void> {
    await this.#call('setRoomSettings', {
      roomId: roomId.toString(),
      roomSettings: roomSettingsJson(roomSettings),
    });
  }

  public async invalidateGroupSession(roomId: RoomId): Promise<boolean> {
    return (await this.#call('invalidateGroupSession', {
      roomId: roomId.toString(),
    })) as boolean;
  }

  /** A snapshot by kind: matrix-js-sdk tells own and other identities apart with `instanceof`. */
  public async getIdentity(
    userId: UserId,
  ): Promise<OwnUserIdentity | OtherUserIdentity | undefined> {
    const identity = checked<IdentityJson | null>(
      'getIdentity',
      await this.#call('getIdentity', { userId: userId.toString() }),
      (value) => value === null || isIdentity(value),
    );
    return identity
      ? toIdentity(identity, userId.toString(), {
          call: this.#objectCall,
          verifications: this.#verifications,
        })
      : undefined;
  }

  public async getDevice(
    userId: UserId,
    deviceId: DeviceId,
    timeoutSecs?: number | null,
  ): Promise<Device | undefined> {
    const device = checked<DeviceJson | null>(
      'getDevice',
      await this.#call('getDevice', {
        userId: userId.toString(),
        deviceId: deviceId.toString(),
        ...(timeoutSecs == null ? {} : { timeoutSecs }),
      }),
      (value) => value === null || isDevice(value),
    );
    return device
      ? (new NativeDevice(
          device,
          this.#objectCall,
          this.#verifications,
        ) as unknown as Device)
      : undefined;
  }

  public async getUserDevices(
    userId: UserId,
    timeoutSecs?: number | null,
  ): Promise<UserDevices> {
    const devices = checked<DeviceJson[]>(
      'getUserDevices',
      await this.#call('getUserDevices', {
        userId: userId.toString(),
        ...(timeoutSecs == null ? {} : { timeoutSecs }),
      }),
      (value) => Array.isArray(value) && value.every(isDevice),
    );
    return new NativeUserDevices(
      devices.map(
        (device) =>
          new NativeDevice(device, this.#objectCall, this.#verifications),
      ),
    ) as unknown as UserDevices;
  }

  public async crossSigningStatus(): Promise<CrossSigningStatus> {
    return toCrossSigningStatus(
      checked<CrossSigningStatusJson>(
        'crossSigningStatus',
        await this.#call('crossSigningStatus'),
        isCrossSigningStatus,
      ),
    );
  }

  public async bootstrapCrossSigning(
    reset: boolean,
  ): Promise<CrossSigningBootstrapRequests> {
    return toBootstrapRequests(
      checked<Parameters<typeof toBootstrapRequests>[0]>(
        'bootstrapCrossSigning',
        await this.#call('bootstrapCrossSigning', { reset }),
        isBootstrapRequests,
      ),
    );
  }

  /** The private keys, as WASM returns them; the shim keeps no copy. */
  public async exportCrossSigningKeys(): Promise<
    CrossSigningKeyExport | undefined
  > {
    const keys = checked<CrossSigningKeyExportJson | null>(
      'exportCrossSigningKeys',
      await this.#call('exportCrossSigningKeys'),
      (value) => value === null || isCrossSigningKeyExport(value),
    );
    return keys ? toCrossSigningKeyExport(keys) : undefined;
  }

  public async importCrossSigningKeys(
    masterKey?: string | null,
    selfSigningKey?: string | null,
    userSigningKey?: string | null,
  ): Promise<CrossSigningStatus> {
    return toCrossSigningStatus(
      checked<CrossSigningStatusJson>(
        'importCrossSigningKeys',
        await this.#call('importCrossSigningKeys', {
          masterKey,
          selfSigningKey,
          userSigningKey,
        }),
        isCrossSigningStatus,
      ),
    );
  }

  /**
   * Every room key: the predicate cannot cross to the crate, and matrix-js-sdk's only one
   * (`() => true`) keeps every key.
   */
  public async exportRoomKeys(_predicate: unknown): Promise<string> {
    return checked<string>(
      'exportRoomKeys',
      await this.#call('exportRoomKeys'),
      (value) => typeof value === 'string',
    );
  }

  /**
   * The listener is called once, when the import is done, with WASM's last arguments: numbers,
   * as WASM passes them (its declarations say `bigint`).
   */
  public async importExportedRoomKeys(
    exportedRoomKeys: string,
    progressListener: (progress: number, total: number) => void,
  ): Promise<RoomKeyImportResult> {
    return this.#imported(
      'importExportedRoomKeys',
      await this.#call('importExportedRoomKeys', { exportedRoomKeys }),
      progressListener,
    );
  }

  /** As `importExportedRoomKeys`; the listener's third argument counts the failures. */
  public async importBackedUpRoomKeys(
    backedUpRoomKeys: Map<RoomId, Map<string, unknown>>,
    progressListener:
      ((progress: number, total: number, failures: number) => void) | undefined,
    backupVersion: string,
  ): Promise<RoomKeyImportResult> {
    // matrix-js-sdk keys the map by a new RoomId per session, so one room can come many times.
    const rooms: Record<string, Record<string, unknown>> = {};
    for (const [roomId, sessions] of backedUpRoomKeys) {
      Object.assign(
        (rooms[roomId.toString()] ??= {}),
        Object.fromEntries(sessions),
      );
    }
    return this.#imported(
      'importBackedUpRoomKeys',
      await this.#call('importBackedUpRoomKeys', {
        backedUpRoomKeys: rooms,
        backupVersion,
      }),
      progressListener,
    );
  }

  #imported(
    method: string,
    answer: unknown,
    listener: ((...progress: number[]) => void) | undefined,
  ): RoomKeyImportResult {
    const result = checked<ImportResultJson>(method, answer, isImportResult);
    if (result.lastProgress) listener?.(...result.lastProgress);
    return toImportResult(result);
  }

  public async roomKeyCounts(): Promise<RoomKeyCounts> {
    return toRoomKeyCounts(
      checked<Parameters<typeof toRoomKeyCounts>[0]>(
        'roomKeyCounts',
        await this.#call('roomKeyCounts'),
        (value) =>
          isObject(value) &&
          typeof value['total'] === 'number' &&
          typeof value['backedUp'] === 'number',
      ),
    );
  }

  public async backupRoomKeys(): Promise<KeysBackupRequest | undefined> {
    const request = checked<RequestJson | null>(
      'backupRoomKeys',
      await this.#call('backupRoomKeys'),
      (value) =>
        value === null ||
        (isObject(value) && value['type'] === RequestType.KeysBackup),
    );
    return request ? (toRequest(request) as KeysBackupRequest) : undefined;
  }

  /** The decryption key as the real WASM helper, as `BackupKeys.decryptionKey` returns it. */
  public async getBackupKeys(): Promise<BackupKeys> {
    const keys = checked<{
      decryptionKeyBase64?: string;
      backupVersion?: string;
    }>(
      'getBackupKeys',
      await this.#call('getBackupKeys'),
      (value) =>
        isObject(value) &&
        ['decryptionKeyBase64', 'backupVersion'].every(
          (field) =>
            value[field] === undefined || typeof value[field] === 'string',
        ),
    );
    return new NativeBackupKeys(
      keys.decryptionKeyBase64 === undefined
        ? undefined
        : backupKeyFrom(keys.decryptionKeyBase64),
      keys.backupVersion,
    ) as unknown as BackupKeys;
  }

  public async saveBackupDecryptionKey(
    decryptionKey: BackupDecryptionKey,
    version: string,
  ): Promise<void> {
    await this.#call('saveBackupDecryptionKey', {
      decryptionKeyBase64: decryptionKey.toBase64(),
      version,
    });
  }

  public async enableBackupV1(
    publicKeyBase64: string,
    version: string,
  ): Promise<void> {
    await this.#call('enableBackupV1', { publicKeyBase64, version });
  }

  public async disableBackup(): Promise<void> {
    await this.#call('disableBackup');
  }

  public async verifyBackup(
    backupInfo: unknown,
  ): Promise<SignatureVerification> {
    return toSignatureVerification(
      checked<Parameters<typeof toSignatureVerification>[0]>(
        'verifyBackup',
        await this.#call('verifyBackup', { backupInfo }),
        (value) =>
          isObject(value) &&
          typeof value['deviceState'] === 'number' &&
          typeof value['userState'] === 'number' &&
          typeof value['trusted'] === 'boolean',
      ),
    );
  }

  public async sign(message: string): Promise<Signatures> {
    return toSignatures(
      checked('sign', await this.#call('sign', { message }), isObject),
    );
  }

  public async isBackupEnabled(): Promise<boolean> {
    return checked<boolean>(
      'isBackupEnabled',
      await this.#call('isBackupEnabled'),
      (value) => typeof value === 'boolean',
    );
  }

  public async getSecretsFromInbox(secretName: string): Promise<Set<string>> {
    return new Set(
      checked<string[]>(
        'getSecretsFromInbox',
        await this.#call('getSecretsFromInbox', { secretName }),
        (value) =>
          Array.isArray(value) &&
          value.every((secret) => typeof secret === 'string'),
      ),
    );
  }

  public async deleteSecretsFromInbox(secretName: string): Promise<void> {
    await this.#call('deleteSecretsFromInbox', { secretName });
  }

  /** Queues the pushes in `outgoingRequests` (matrix-js-sdk's `resetKeyBackup` sends the backup key). */
  public async pushSecretToVerifiedDevices(secretName: string): Promise<void> {
    await this.#call('pushSecretToVerifiedDevices', { secretName });
  }

  public async getAllRoomsPendingKeyBundles(): Promise<
    RoomPendingKeyBundleDetails[]
  > {
    return (
      (await this.#call('getAllRoomsPendingKeyBundles')) as PendingBundleJson[]
    ).map(toPendingBundle);
  }

  public async getPendingKeyBundleDetailsForRoom(
    roomId: RoomId,
  ): Promise<RoomPendingKeyBundleDetails | undefined> {
    const details = (await this.#call('getPendingKeyBundleDetailsForRoom', {
      roomId: roomId.toString(),
    })) as PendingBundleJson | null;
    return details ? toPendingBundle(details) : undefined;
  }

  public async storeRoomPendingKeyBundle(
    roomId: RoomId,
    inviter: UserId,
  ): Promise<void> {
    await this.#call('storeRoomPendingKeyBundle', {
      roomId: roomId.toString(),
      inviter: inviter.toString(),
    });
  }

  public async getReceivedRoomKeyBundleData(
    roomId: RoomId,
    inviter: UserId,
  ): Promise<StoredRoomKeyBundleData | undefined> {
    const data = checked<BundleDataJson | null>(
      'getReceivedRoomKeyBundleData',
      await this.#call('getReceivedRoomKeyBundleData', {
        roomId: roomId.toString(),
        inviter: inviter.toString(),
      }),
      (value) => value === null || isBundleData(value),
    );
    return data ? toBundleData(data) : undefined;
  }

  /**
   * WASM takes the bundle data object JavaScript cannot forge; the crate reads it again by room
   * and inviter and refuses (`StaleObject`) when its URL is not the one downloaded.
   */
  public async receiveRoomKeyBundle(
    bundleData: StoredRoomKeyBundleData,
    encryptedBundle: Uint8Array,
  ): Promise<void> {
    await this.#call('receiveRoomKeyBundle', {
      roomId: bundleData.roomId.toString(),
      inviter: bundleData.senderUser.toString(),
      url: bundleData.url,
      encryptedBundle: bytesToBase64(encryptedBundle),
    });
  }

  public async buildRoomKeyBundle(
    roomId: RoomId,
  ): Promise<EncryptedAttachment | undefined> {
    const bundle = checked<{
      encryptedData: string;
      mediaEncryptionInfo: string;
    } | null>(
      'buildRoomKeyBundle',
      await this.#call('buildRoomKeyBundle', { roomId: roomId.toString() }),
      (value) =>
        value === null ||
        (isObject(value) &&
          typeof value['encryptedData'] === 'string' &&
          typeof value['mediaEncryptionInfo'] === 'string'),
    );
    return bundle
      ? new EncryptedAttachment(
          base64ToBytes(bundle.encryptedData),
          bundle.mediaEncryptionInfo,
        )
      : undefined;
  }

  public async shareRoomKeyBundleData(
    userId: UserId,
    roomId: RoomId,
    url: string,
    mediaEncryptionInfo: string | undefined,
    sharingStrategy: CollectStrategy,
  ): Promise<ToDeviceRequest[]> {
    const requests = checked<RequestJson[]>(
      'shareRoomKeyBundleData',
      await this.#call('shareRoomKeyBundleData', {
        userId: userId.toString(),
        roomId: roomId.toString(),
        url,
        mediaEncryptionInfo,
        sharingStrategy: strategyName(sharingStrategy),
      }),
      (value) =>
        Array.isArray(value) &&
        value.every(
          (request) =>
            isObject(request) && request['type'] === RequestType.ToDevice,
        ),
    );
    return requests.map(toRequest) as ToDeviceRequest[];
  }

  public async hasDownloadedAllRoomKeys(roomId: RoomId): Promise<boolean> {
    return checked<boolean>(
      'hasDownloadedAllRoomKeys',
      await this.#call('hasDownloadedAllRoomKeys', {
        roomId: roomId.toString(),
      }),
      (value) => typeof value === 'boolean',
    );
  }

  public async setHasDownloadedAllRoomKeys(roomId: RoomId): Promise<void> {
    await this.#call('setHasDownloadedAllRoomKeys', {
      roomId: roomId.toString(),
    });
  }

  /** The private cross-signing seeds and the backup key, as WASM returns them. */
  public async exportSecretsBundle(): Promise<SecretsBundle> {
    return new NativeSecretsBundle(
      checked(
        'exportSecretsBundle',
        await this.#call('exportSecretsBundle'),
        isSecretsBundle,
      ),
    ) as unknown as SecretsBundle;
  }

  /** Takes the bundle as WASM does: it is freed whatever the outcome. */
  public async importSecretsBundle(bundle: SecretsBundle): Promise<void> {
    try {
      await this.#call('importSecretsBundle', { bundle: bundle.to_json() });
    } finally {
      bundle.free();
    }
  }

  /** From the registry, which the crate's answers and events keep (see verification.ts). */
  public getVerificationRequest(
    userId: UserId,
    flowId: string,
  ): VerificationRequest | undefined {
    return this.#verifications.get(userId.toString(), flowId);
  }

  public getVerificationRequests(userId: UserId): VerificationRequest[] {
    return this.#verifications.forUser(userId.toString());
  }

  /** An in-room verification event; a new request goes in the registry before this resolves. */
  public async receiveVerificationEvent(
    event: string,
    roomId: RoomId,
  ): Promise<void> {
    await this.#call('receiveVerificationEvent', {
      event,
      roomId: roomId.toString(),
    });
    const found = incomingRequest(event);
    if (found) await this.#fetchRequest(found);
  }

  /** Its calls hold nothing: the crate's dehydrated device calls are addressed by device ID. */
  public dehydratedDevices(): DehydratedDevices {
    return new NativeDehydratedDevices(
      this.#objectCall,
      this.#context.logger,
    ) as unknown as DehydratedDevices;
  }

  public async clearRoomPendingKeyBundle(roomId: RoomId): Promise<void> {
    await this.#call('clearRoomPendingKeyBundle', {
      roomId: roomId.toString(),
    });
  }

  /** WASM's `close` is synchronous: the native close runs after every call queued before it. */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store = undefined;
    this.#verifications.clear();
    if (this.#lost) return;
    this.#send('close').then(
      () => this.#context.queue.unlisten(this.#description),
      (error: unknown) => {
        this.#context.queue.unlisten(this.#description);
        this.#context.logger?.warn(
          `native crypto close failed: ${describeError(error)}`,
        );
      },
    );
  }

  /** Owns no wasm memory; `close` releases the native machine. */
  public free(): void {
    return undefined;
  }
}
standIn(NativeOlmMachine, OlmMachine);

const sessionKey = (roomId: string, sessionId: string) =>
  JSON.stringify([roomId, sessionId]);

/** WASM's decoder error names a character of the key and its offset: a fixed one instead. */
function backupKeyFrom(base64: string): BackupDecryptionKey {
  try {
    return BackupDecryptionKey.fromBase64(base64);
  } catch {
    throw new NativeCryptoError(
      'getBackupKeys',
      'UnexpectedAnswer',
      'invalid backup decryption key',
    );
  }
}

const decryptionSettingsJson = (settings: DecryptionSettings) => ({
  sender_device_trust_requirement: settings.sender_device_trust_requirement,
});
