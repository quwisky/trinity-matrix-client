// Dehydrated devices on the native crate (MSC3814). The crate's calls hold no handle
// (native/crypto/README.md): creating a device and building its upload request is one call, and
// a rehydrated device is held in the open machine under its device ID until it is dropped. The
// keys travel as WASM's `DehydratedDeviceKey.toBase64()`, the form the crate takes.
import {
  DehydratedDevice,
  DehydratedDeviceKey,
  DehydratedDevices,
  type DecryptionSettings,
  type DeviceId,
  PutDehydratedDeviceRequest,
  RehydratedDevice,
  type RoomKeyInfo,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import { base64ToBytes, toRoomKeyInfo } from './convert';
import { standIn } from './guard';
import type { MachineCall } from './trust';
import {
  checked,
  describeError,
  isObject,
  NativeCryptoError,
  type NativeCryptoLogger,
} from './types';

type RoomKeyJson = Parameters<typeof toRoomKeyInfo>[0];

const isRoomKey = (value: unknown) =>
  isObject(value) &&
  typeof value['algorithm'] === 'number' &&
  typeof value['roomId'] === 'string' &&
  typeof value['senderKey'] === 'string' &&
  typeof value['sessionId'] === 'string';

/** WASM `DehydratedDevices`: the machine's calls, nothing held. */
export class NativeDehydratedDevices {
  readonly #call: MachineCall;
  readonly #logger: NativeCryptoLogger | undefined;

  public constructor(call: MachineCall, logger?: NativeCryptoLogger) {
    this.#call = call;
    this.#logger = logger;
  }

  /** Deferred to `keysForUpload`: upstream's `create` touches nothing but a fresh memory store. */
  public async create(): Promise<DehydratedDevice> {
    return new NativeDehydratedDevice(
      this.#call,
    ) as unknown as DehydratedDevice;
  }

  public async getDehydratedDeviceKey(): Promise<
    DehydratedDeviceKey | undefined
  > {
    const key = checked<string | null>(
      'getDehydratedDeviceKey',
      await this.#call('getDehydratedDeviceKey', {}),
      (value) => value === null || typeof value === 'string',
    );
    if (key === null) return undefined;
    const bytes = base64ToBytes(key);
    try {
      return DehydratedDeviceKey.createKeyFromArray(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  public async saveDehydratedDeviceKey(
    key: DehydratedDeviceKey,
  ): Promise<void> {
    await this.#call('saveDehydratedDeviceKey', {
      dehydratedDeviceKey: key.toBase64(),
    });
  }

  public async rehydrate(
    key: DehydratedDeviceKey,
    deviceId: DeviceId,
    deviceData: string,
  ): Promise<RehydratedDevice> {
    await this.#call('rehydrateDevice', {
      dehydratedDeviceKey: key.toBase64(),
      deviceId: deviceId.toString(),
      deviceData,
    });
    return new NativeRehydratedDevice(
      this.#call,
      deviceId.toString(),
      this.#logger,
    ) as unknown as RehydratedDevice;
  }

  public free(): void {
    return undefined;
  }
}
standIn(NativeDehydratedDevices, DehydratedDevices);

/** WASM `DehydratedDevice`: one upload request, made by the crate in one call. */
export class NativeDehydratedDevice {
  readonly #call: MachineCall;
  #used = false;

  public constructor(call: MachineCall) {
    this.#call = call;
  }

  /** Once per object, as matrix-js-sdk calls it: a second call would make another device. */
  public async keysForUpload(
    initialDeviceDisplayName: string,
    key: DehydratedDeviceKey,
  ): Promise<PutDehydratedDeviceRequest> {
    if (this.#used) {
      throw new NativeCryptoError(
        'createDehydratedDevice',
        'InvalidRequest',
        'this dehydrated device was turned into its upload request already',
      );
    }
    this.#used = true;
    const request = checked<{ body: string }>(
      'createDehydratedDevice',
      await this.#call('createDehydratedDevice', {
        initialDeviceDisplayName,
        dehydratedDeviceKey: key.toBase64(),
      }),
      (value) => isObject(value) && typeof value['body'] === 'string',
    );
    return new PutDehydratedDeviceRequest(request.body);
  }

  public free(): void {
    return undefined;
  }
}
standIn(NativeDehydratedDevice, DehydratedDevice);

/** WASM `RehydratedDevice`: the device the crate holds under its ID; `free` drops it. */
export class NativeRehydratedDevice {
  readonly #call: MachineCall;
  readonly #deviceId: string;
  readonly #logger: NativeCryptoLogger | undefined;

  public constructor(
    call: MachineCall,
    deviceId: string,
    logger?: NativeCryptoLogger,
  ) {
    this.#call = call;
    this.#deviceId = deviceId;
    this.#logger = logger;
  }

  public async receiveEvents(
    toDeviceEvents: string,
    decryptionSettings?: DecryptionSettings | null,
  ): Promise<RoomKeyInfo[]> {
    const keys = checked<RoomKeyJson[]>(
      'receiveRehydratedEvents',
      await this.#call('receiveRehydratedEvents', {
        deviceId: this.#deviceId,
        toDeviceEvents,
        ...(decryptionSettings
          ? {
              decryptionSettings: {
                sender_device_trust_requirement:
                  decryptionSettings.sender_device_trust_requirement,
              },
            }
          : {}),
      }),
      (value) => Array.isArray(value) && value.every(isRoomKey),
    );
    return keys.map(toRoomKeyInfo);
  }

  /** WASM's `free` is synchronous: the native drop runs after every call queued before it. */
  public free(): void {
    this.#call('dropRehydratedDevice', { deviceId: this.#deviceId }).catch(
      (error: unknown) =>
        this.#logger?.warn(
          `native crypto dropRehydratedDevice failed: ${describeError(error)}`,
        ),
    );
  }
}
standIn(NativeRehydratedDevice, RehydratedDevice);
