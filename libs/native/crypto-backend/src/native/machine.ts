import {
  BackupDecryptionKey,
  type BackupKeys,
  type CrossSigningBootstrapRequests,
  type CrossSigningKeyExport,
  type CrossSigningStatus,
  type DecryptedRoomEvent,
  type DecryptionSettings,
  DeviceId,
  type Device,
  type DeviceLists,
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
  type Signatures,
  type SignatureVerification,
  StoreHandle,
  type StoredRoomKeyBundleData,
  type ToDeviceRequest,
  type UserDevices,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import type { CallQueue } from './call-queue';
import {
  type CrossSigningStatusJson,
  encryptionSettingsJson,
  type EncryptionInfoJson,
  type ImportResultJson,
  isCrossSigningStatus,
  isImportResult,
  type MegolmErrorDetails,
  type RequestJson,
  roomSettingsJson,
  type RoomSettingsJson,
  toBootstrapRequests,
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
import { NotOnNativeError, standIn } from './guard';
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
 * fails and is run again), `pushSecretToVerifiedDevices` (it could queue the secret to every
 * verified device twice) — and `close`.
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
  // Keys already imported are skipped (the replay reports fewer new ones).
  'importExportedRoomKeys',
  'importBackedUpRoomKeys',
]);

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
  #lost = false;
  #closed = false;
  /** How the device and identity stand-ins call: through this machine's reload and loss rules. */
  readonly #objectCall: MachineCall = (method, params) =>
    this.#call(method, params);

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
    context.queue.listen(
      description,
      (events) => this.#deliver(events),
      (reason, malformed) => {
        this.#context.logger?.warn(reason);
        this.#context.onEventsDropped?.(undefined);
        if (malformed) this.#lose(reason);
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
    // A reload in flight goes first, then the replays it holds, then this call.
    if (this.#recovery) await this.#afterRecovery(method);
    try {
      return await this.#send(method, params);
    } catch (error) {
      if (!this.#isDropped(error)) throw this.#failure(method, error);
      await this.#recover(method);
      if (!REPLAYABLE.has(method)) throw error;
      try {
        return await this.#send(method, params);
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

  #afterRecovery(method: string): Promise<void> {
    return (this.#recovery ?? Promise.resolve()).then(() => {
      if (this.#lost) throw new NativeMachineLostError(method);
    });
  }

  #recover(method: string): Promise<void> {
    const store = this.#store;
    if (this.#lost || !store)
      return Promise.reject(new NativeMachineLostError(method));
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
      } catch (error) {
        this.#lose(
          `init could not reload the machine: ${describeError(error)}`,
        );
      } finally {
        this.#recovery = undefined;
      }
    })();
    return this.#afterRecovery(method);
  }

  #lose(reason: string): void {
    if (this.#lost) return;
    this.#lost = true;
    this.#store = undefined;
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
        case 'roomKeysReceived':
          this.#invoke(
            'roomKeysReceived',
            (event['keys'] as Parameters<typeof toRoomKeyInfo>[0][]).map(
              toRoomKeyInfo,
            ),
          );
          break;
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
        default:
          this.#context.logger?.warn(
            `native crypto event ${event.type} has no handler on native yet`,
          );
      }
    }
    if (dropped > 0) {
      this.#context.logger?.warn(
        `native crypto dropped ${dropped} events: undecryptable events need a retry`,
      );
      this.#context.onEventsDropped?.(dropped);
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
    if (!Array.isArray(answer)) {
      this.#lose(`${method} answered an unexpected shape`);
      return forever();
    }
    return (answer as Parameters<typeof toProcessedToDeviceEvent>[0][]).map(
      toProcessedToDeviceEvent,
    );
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
      return toDecryptedRoomEvent(
        checked<Parameters<typeof toDecryptedRoomEvent>[0]>(
          'decryptRoomEvent',
          decrypted,
          (value) =>
            isEncryptionInfo(value) &&
            isObject(value) &&
            typeof value['event'] === 'string',
        ),
      );
    } catch (error) {
      if (
        error instanceof NativeCryptoError &&
        error.code === 'MegolmDecryptionError'
      ) {
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
      ? toIdentity(identity, userId.toString(), this.#objectCall)
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
      ? (new NativeDevice(device, this.#objectCall) as unknown as Device)
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
      devices.map((device) => new NativeDevice(device, this.#objectCall)),
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
        (value) =>
          isObject(value) &&
          isObject(value['uploadSigningKeysRequest']) &&
          isObject(value['uploadSignaturesRequest']),
      ),
    );
  }

  /** The private keys, as WASM returns them; the shim keeps no copy. */
  public async exportCrossSigningKeys(): Promise<
    CrossSigningKeyExport | undefined
  > {
    const keys = checked<Parameters<typeof toCrossSigningKeyExport>[0] | null>(
      'exportCrossSigningKeys',
      await this.#call('exportCrossSigningKeys'),
      (value) => value === null || isObject(value),
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

  /** The listener is called once, when the import is done, with WASM's last arguments. */
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
        : BackupDecryptionKey.fromBase64(keys.decryptionKeyBase64),
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
      (await this.#call('getSecretsFromInbox', { secretName })) as string[],
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

  /** Only "no bundle" so far: received bundles come with the room key bundle calls. */
  public async getReceivedRoomKeyBundleData(
    roomId: RoomId,
    inviter: UserId,
  ): Promise<StoredRoomKeyBundleData | undefined> {
    const data = await this.#call('getReceivedRoomKeyBundleData', {
      roomId: roomId.toString(),
      inviter: inviter.toString(),
    });
    if (data === null) return undefined;
    throw new NotOnNativeError(
      'OlmMachine.getReceivedRoomKeyBundleData (a received bundle)',
    );
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

const decryptionSettingsJson = (settings: DecryptionSettings) => ({
  sender_device_trust_requirement: settings.sender_device_trust_requirement,
});
