import {
  type DecryptedRoomEvent,
  type DecryptionSettings,
  DeviceId,
  type DeviceLists,
  type EncryptionInfo,
  type EncryptionSettings,
  type IdentityKeys,
  type KeysClaimRequest,
  type KeysQueryRequest,
  OlmMachine,
  type OtherUserIdentity,
  type OutgoingRequest,
  type OwnUserIdentity,
  type ProcessedToDeviceEvent,
  type RequestType,
  type RoomKeyInfo,
  type RoomKeyWithheldInfo,
  type RoomId,
  type RoomPendingKeyBundleDetails,
  type RoomSettings,
  StoreHandle,
  type StoredRoomKeyBundleData,
  type ToDeviceRequest,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import type { CallQueue } from './call-queue';
import {
  encryptionSettingsJson,
  type EncryptionInfoJson,
  type MegolmErrorDetails,
  type RequestJson,
  roomSettingsJson,
  type RoomSettingsJson,
  toDecryptedRoomEvent,
  toEncryptionInfo,
  toIdentityKeys,
  toMegolmDecryptionError,
  type PendingBundleJson,
  toPendingBundle,
  toProcessedToDeviceEvent,
  toRequest,
  toRoomKeyInfo,
  toRoomKeyWithheldInfo,
  toRoomSettings,
} from './convert';
import { NotOnNativeError, standIn } from './guard';
import {
  NativeCryptoError,
  type NativeCryptoLogger,
  type NativeEvents,
} from './types';

/** What `init` opens: a SQLite store with its raw key, or memory. */
export class NativeStoreHandle {
  #store: { storePath: string; storeKey: string } | undefined;

  public constructor(store?: { storePath: string; storeKey: string }) {
    this.#store = store;
  }

  /** The `init` parameters; the key is handed out once. */
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
  readonly onEventsDropped?: (dropped: number) => void;
}

type Callback = (...args: never[]) => unknown;

/**
 * `OlmMachine` on the native crate. The constants are read once at `init`; every other
 * member is a call through the queue. Members not here throw (see guard.ts).
 */
export class NativeOlmMachine {
  readonly #context: MachineContext;
  readonly #description: MachineDescription;
  #roomKeyRequestsEnabled: boolean;
  readonly #callbacks = new Map<string, Callback>();

  private constructor(
    context: MachineContext,
    description: MachineDescription,
    roomKeyRequestsEnabled: boolean,
  ) {
    this.#context = context;
    this.#description = description;
    this.#roomKeyRequestsEnabled = roomKeyRequestsEnabled;
    context.queue.listen(description, (events) => this.#deliver(events));
  }

  public static async init(
    context: MachineContext,
    userId: UserId,
    deviceId: DeviceId,
    store: NativeStoreHandle,
  ): Promise<NativeOlmMachine> {
    const ids = { userId: userId.toString(), deviceId: deviceId.toString() };
    const [description, enabled] = await Promise.all([
      context.queue.call({ method: 'init', ...ids, params: store.take() }),
      context.queue.call({ method: 'roomKeyRequestsEnabled', ...ids }),
    ]);
    return new NativeOlmMachine(
      context,
      description as MachineDescription,
      enabled as boolean,
    );
  }

  #call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const { userId, deviceId } = this.#description;
    return this.#context.queue.call({
      method,
      userId,
      deviceId,
      ...(params ? { params } : {}),
    });
  }

  /** Runs a call nobody awaits (WASM's member is synchronous) and reports its failure. */
  #detach(method: string, params?: Record<string, unknown>): void {
    this.#call(method, params).catch((error: unknown) =>
      this.#context.logger?.warn(`native crypto ${method} failed`, error),
    );
  }

  #invoke(name: string, ...args: unknown[]): void {
    const callback = this.#callbacks.get(name) as
      ((...values: unknown[]) => unknown) | undefined;
    if (!callback) return;
    try {
      Promise.resolve(callback(...args)).catch((error: unknown) =>
        this.#context.logger?.warn(
          `native crypto ${name} callback failed`,
          error,
        ),
      );
    } catch (error) {
      this.#context.logger?.warn(
        `native crypto ${name} callback failed`,
        error,
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
    this.#roomKeyRequestsEnabled = enabled;
    this.#detach('roomKeyRequestsEnabled', { enabled });
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
    const events = (await this.#call(method, {
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
    })) as Parameters<typeof toProcessedToDeviceEvent>[0][];
    return events.map(toProcessedToDeviceEvent);
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
    const request = (await this.#call('getMissingSessions', {
      users: users.map(String),
    })) as RequestJson | null;
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
        decrypted as Parameters<typeof toDecryptedRoomEvent>[0],
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
    return toEncryptionInfo(info as EncryptionInfoJson);
  }

  public async getRoomSettings(
    roomId: RoomId,
  ): Promise<RoomSettings | undefined> {
    const settings = (await this.#call('getRoomSettings', {
      roomId: roomId.toString(),
    })) as RoomSettingsJson | null;
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

  /** Only "no identity" so far: the identity stand-ins come with the trust calls. */
  public async getIdentity(
    userId: UserId,
  ): Promise<OwnUserIdentity | OtherUserIdentity | undefined> {
    const identity = await this.#call('getIdentity', {
      userId: userId.toString(),
    });
    if (identity === null) return undefined;
    throw new NotOnNativeError('OlmMachine.getIdentity (a cross-signed user)');
  }

  public async isBackupEnabled(): Promise<boolean> {
    return (await this.#call('isBackupEnabled')) as boolean;
  }

  public async getSecretsFromInbox(secretName: string): Promise<Set<string>> {
    return new Set(
      (await this.#call('getSecretsFromInbox', { secretName })) as string[],
    );
  }

  public async deleteSecretsFromInbox(secretName: string): Promise<void> {
    await this.#call('deleteSecretsFromInbox', { secretName });
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
    this.#call('close').then(
      () => this.#context.queue.unlisten(this.#description),
      (error: unknown) => {
        this.#context.queue.unlisten(this.#description);
        this.#context.logger?.warn('native crypto close failed', error);
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
