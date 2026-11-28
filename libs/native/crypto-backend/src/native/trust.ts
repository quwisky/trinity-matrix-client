// Devices, user identities and backup keys on the native crate. The crate answers each with a
// snapshot of every getter matrix-js-sdk reads (native/crypto/README.md); the stand-ins below
// answer those reads synchronously from it and forward every method as a call that carries the
// key the snapshot was read with, so the crate refuses (`StaleObject`) to act on a device or
// identity that changed since.
//
// What is live, as in matrix-sdk-crypto 0.19.1 under WASM: an object's own change is. WASM's
// `Device.setLocalTrust`, `OwnUserIdentity.verify` and `withdrawVerification`, and
// `OtherUserIdentity.pinCurrentMasterKey` and `withdrawVerification` update the trust state the
// same object holds (shared `Arc`s), so a read after them answers the new state; each of these
// stand-ins reads its object again before its promise resolves, and a stand-in whose device or
// identity is gone or has another key by then is spent: its reads throw. `Device.verify` and
// `OtherUserIdentity.verify` only sign (trust follows from the next key query), so WASM's object
// keeps its answers and so does the stand-in. A change made elsewhere (a key query after a sync,
// another object of the same device) does not reach either: WASM builds each object from the
// store's data when it is read, and the persistent stores give a new copy each time (only an
// in-memory store would share a device's local trust between its objects). So a holder must read
// a device or identity again after `devicesUpdated` or `userIdentityUpdated`, on both backends;
// matrix-js-sdk reads them again for each trust question.
import {
  BackupDecryptionKey,
  BackupKeys,
  type CollectStrategy,
  Device,
  DeviceId,
  DeviceKey,
  DeviceKeyId,
  type EncryptionAlgorithm,
  type LocalTrust,
  MaybeSignature,
  OtherUserIdentity,
  OwnUserIdentity,
  RequestType,
  Signature,
  Signatures,
  type SignatureUploadRequest,
  UserDevices,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import { type RequestJson, strategyName, toRequest } from './convert';
import { standIn, wasmValue } from './guard';
import { checked, isObject, NativeCryptoError } from './types';

/** A call on the machine the object came from (its reload and loss rules apply). */
export type MachineCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

type MaybeSignatureJson =
  | { readonly isValid: true; readonly signature: string }
  | { readonly isValid: false; readonly invalidSignatureSource: string };

export interface DeviceJson {
  readonly userId: string;
  readonly deviceId: string;
  readonly displayName?: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly algorithms: readonly EncryptionAlgorithm[];
  readonly signatures: Readonly<
    Record<string, Readonly<Record<string, MaybeSignatureJson>>>
  >;
  readonly isVerified: boolean;
  readonly isCrossSigningTrusted: boolean;
  readonly isCrossSignedByOwner: boolean;
  readonly isLocallyTrusted: boolean;
  readonly isBlacklisted: boolean;
  readonly localTrustState: LocalTrust;
  readonly isDeleted: boolean;
  readonly isDehydrated: boolean;
}

const DEVICE_FLAGS = [
  'isVerified',
  'isCrossSigningTrusted',
  'isCrossSignedByOwner',
  'isLocallyTrusted',
  'isBlacklisted',
  'isDeleted',
  'isDehydrated',
] as const;

const isStringRecord = (value: unknown) =>
  isObject(value) &&
  Object.values(value).every((entry) => typeof entry === 'string');

const isSignature = (value: unknown) =>
  isObject(value) &&
  (value['isValid'] === true
    ? typeof value['signature'] === 'string'
    : value['isValid'] === false &&
      typeof value['invalidSignatureSource'] === 'string');

export const isDevice = (value: unknown): boolean =>
  isObject(value) &&
  typeof value['userId'] === 'string' &&
  typeof value['deviceId'] === 'string' &&
  (value['displayName'] === undefined ||
    typeof value['displayName'] === 'string') &&
  isStringRecord(value['keys']) &&
  Array.isArray(value['algorithms']) &&
  value['algorithms'].every((algorithm) => typeof algorithm === 'number') &&
  isObject(value['signatures']) &&
  Object.values(value['signatures']).every(
    (bySigner) =>
      isObject(bySigner) && Object.values(bySigner).every(isSignature),
  ) &&
  // WASM `LocalTrust`: Verified, BlackListed, Ignored, Unset.
  [0, 1, 2, 3].includes(value['localTrustState'] as number) &&
  DEVICE_FLAGS.every((flag) => typeof value[flag] === 'boolean');

/** A `SignatureUploadRequest` as `verifyDevice` and `verifyIdentity` answer it (no `id`). */
const isSignatureUpload = (value: unknown) =>
  isObject(value) &&
  value['type'] === RequestType.SignatureUpload &&
  typeof value['body'] === 'string';

/** A read of a stand-in whose object changed under it after its own call: no stale answer. */
const spent = (member: string, what: string): NativeCryptoError =>
  new NativeCryptoError(
    member,
    'StaleObject',
    `the ${what} changed or is gone since its last call; read it again`,
  );

const maybeSignature = (json: MaybeSignatureJson): MaybeSignature =>
  wasmValue(MaybeSignature, {
    isValid: () => json.isValid,
    isInvalid: () => !json.isValid,
    signature: json.isValid
      ? wasmValue(Signature, { toBase64: () => json.signature })
      : undefined,
    invalidSignatureSource: json.isValid
      ? undefined
      : json.invalidSignatureSource,
  });

/**
 * WASM `Device`: the getters from the snapshot, the methods as calls with its ed25519 key.
 * Not here (they throw): `requestVerification` (slice 4), `getKey`, `firstTimeSeen` and the
 * key getters matrix-js-sdk does not read.
 */
export class NativeDevice {
  /** `undefined` once spent (see the header). */
  #json: DeviceJson | undefined;
  readonly #call: MachineCall;

  public constructor(json: DeviceJson, call: MachineCall) {
    this.#json = json;
    this.#call = call;
  }

  #read(member: string): DeviceJson {
    if (!this.#json) throw spent(`Device.${member}`, 'device');
    return this.#json;
  }

  /** The device the call acts on, as this snapshot read it; refused without its ed25519 key. */
  #target(method: string): Record<string, string> {
    const { userId, deviceId, keys } = this.#read(method);
    const ed25519Key = keys[`ed25519:${deviceId}`];
    if (ed25519Key === undefined) {
      throw new NativeCryptoError(
        method,
        'UnexpectedAnswer',
        'the device has no ed25519 key',
      );
    }
    return { userId, deviceId, ed25519Key };
  }

  /** Reads the device again after its own change; spent unless it is still the same device. */
  async #refresh(target: Record<string, string>): Promise<void> {
    const { userId, deviceId, ed25519Key } = target;
    try {
      const next = await this.#call('getDevice', { userId, deviceId });
      this.#json =
        isDevice(next) &&
        (next as DeviceJson).keys[`ed25519:${deviceId}`] === ed25519Key
          ? (next as DeviceJson)
          : undefined;
    } catch {
      this.#json = undefined;
    }
  }

  public get userId(): UserId {
    return new UserId(this.#read('userId').userId);
  }

  public get deviceId(): DeviceId {
    return new DeviceId(this.#read('deviceId').deviceId);
  }

  public get displayName(): string | undefined {
    return this.#read('displayName').displayName;
  }

  public get keys(): Map<DeviceKeyId, DeviceKey> {
    return new Map(
      Object.entries(this.#read('keys').keys).map(([id, key]) => [
        new DeviceKeyId(id),
        wasmValue(DeviceKey, { toBase64: () => key }),
      ]),
    );
  }

  public get algorithms(): EncryptionAlgorithm[] {
    return [...this.#read('algorithms').algorithms];
  }

  /** Only `get(signer)` is answered, the one member matrix-js-sdk reads. */
  public get signatures(): Signatures {
    const signatures = this.#read('signatures').signatures;
    return wasmValue(Signatures, {
      get: (signer: UserId) => {
        const bySigner = signatures[signer.toString()];
        return bySigner
          ? new Map(
              Object.entries(bySigner).map(([id, json]) => [
                id,
                maybeSignature(json),
              ]),
            )
          : undefined;
      },
    });
  }

  public get localTrustState(): LocalTrust {
    return this.#read('localTrustState').localTrustState;
  }

  public get isDehydrated(): boolean {
    return this.#read('isDehydrated').isDehydrated;
  }

  public isVerified(): boolean {
    return this.#read('isVerified').isVerified;
  }

  public isCrossSigningTrusted(): boolean {
    return this.#read('isCrossSigningTrusted').isCrossSigningTrusted;
  }

  public isCrossSignedByOwner(): boolean {
    return this.#read('isCrossSignedByOwner').isCrossSignedByOwner;
  }

  public isLocallyTrusted(): boolean {
    return this.#read('isLocallyTrusted').isLocallyTrusted;
  }

  public isBlacklisted(): boolean {
    return this.#read('isBlacklisted').isBlacklisted;
  }

  public isDeleted(): boolean {
    return this.#read('isDeleted').isDeleted;
  }

  /** Resolves once this object answers the new trust, as WASM's does. */
  public async setLocalTrust(localState: LocalTrust): Promise<null> {
    const target = this.#target('setLocalTrust');
    try {
      await this.#call('setLocalTrust', { ...target, localState });
    } finally {
      // Upstream changes the object before it saves, so a failed save leaves it changed too.
      await this.#refresh(target);
    }
    return null;
  }

  public async verify(): Promise<SignatureUploadRequest> {
    return toRequest(
      checked<RequestJson>(
        'verifyDevice',
        await this.#call('verifyDevice', this.#target('verifyDevice')),
        isSignatureUpload,
      ),
    ) as SignatureUploadRequest;
  }

  /** A replaced device rejects (`StaleObject`): matrix-js-sdk's batch then fails, as for any one failed device. */
  public async encryptToDeviceEvent(
    eventType: string,
    content: unknown,
    shareStrategy?: CollectStrategy | null,
  ): Promise<string> {
    return checked<string>(
      'encryptToDeviceEvent',
      await this.#call('encryptToDeviceEvent', {
        ...this.#target('encryptToDeviceEvent'),
        eventType,
        content,
        ...(shareStrategy
          ? { shareStrategy: strategyName(shareStrategy) }
          : {}),
      }),
      (value) => typeof value === 'string',
    );
  }

  /** Owns no wasm memory. */
  public free(): void {
    return undefined;
  }
}
standIn(NativeDevice, Device);

/** WASM `UserDevices`: the device snapshots one `getUserDevices` answered. */
export class NativeUserDevices {
  readonly #devices: readonly NativeDevice[];

  public constructor(devices: readonly NativeDevice[]) {
    this.#devices = devices;
  }

  public devices(): Device[] {
    return [...this.#devices] as unknown as Device[];
  }

  public free(): void {
    return undefined;
  }
}
standIn(NativeUserDevices, UserDevices);

export interface IdentityJson {
  readonly kind: 'own' | 'other';
  readonly isVerified: boolean;
  readonly wasPreviouslyVerified: boolean;
  readonly hasVerificationViolation: boolean;
  readonly masterKey: string;
  readonly selfSigningKey: string;
  readonly userSigningKey?: string;
  readonly identityNeedsUserApproval?: boolean;
}

export const isIdentity = (value: unknown): boolean =>
  isObject(value) &&
  ['isVerified', 'wasPreviouslyVerified', 'hasVerificationViolation'].every(
    (flag) => typeof value[flag] === 'boolean',
  ) &&
  typeof value['masterKey'] === 'string' &&
  typeof value['selfSigningKey'] === 'string' &&
  (value['kind'] === 'own'
    ? typeof value['userSigningKey'] === 'string'
    : value['kind'] === 'other' &&
      typeof value['identityNeedsUserApproval'] === 'boolean');

type OwnJson = IdentityJson & { readonly userSigningKey: string };
type OtherJson = IdentityJson & { readonly identityNeedsUserApproval: boolean };

/** The snapshot an identity stand-in answers from, and its calls. */
class IdentitySnapshot<T extends IdentityJson> {
  /** `undefined` once spent (see the header). */
  #json: T | undefined;
  readonly #userId: string;
  readonly #call: MachineCall;
  readonly #owner: string;

  public constructor(
    json: T,
    userId: string,
    call: MachineCall,
    owner: string,
  ) {
    this.#json = json;
    this.#userId = userId;
    this.#call = call;
    this.#owner = owner;
  }

  public read(member: string): T {
    if (!this.#json) throw spent(`${this.#owner}.${member}`, 'identity');
    return this.#json;
  }

  /**
   * The identity a call acts on, as the snapshot read it: its user and the public master key
   * (the one key of the `masterKey` JSON); refused when the snapshot holds none.
   */
  public target(method: string): Record<string, string> {
    const masterKey = publicMasterKey(this.read(method).masterKey);
    if (masterKey === undefined) {
      throw new NativeCryptoError(
        method,
        'UnexpectedAnswer',
        'the identity has no master key',
      );
    }
    return { userId: this.#userId, masterKey };
  }

  /** A call that changes the object's own state: read again, as WASM's object shows it. */
  public async change(method: string): Promise<void> {
    const target = this.target(method);
    try {
      await this.#call(method, target);
    } finally {
      // Upstream changes the object before it saves, so a failed save leaves it changed too.
      await this.#refresh(target);
    }
  }

  /**
   * Signs. The own identity is marked verified on the object before it signs (`refresh`), so
   * it is read again whether signing succeeds or fails.
   */
  public async verify(refresh: boolean): Promise<SignatureUploadRequest> {
    const target = this.target('verifyIdentity');
    try {
      return toRequest(
        checked<RequestJson>(
          'verifyIdentity',
          await this.#call('verifyIdentity', target),
          isSignatureUpload,
        ),
      ) as SignatureUploadRequest;
    } finally {
      if (refresh) await this.#refresh(target);
    }
  }

  /** Spent unless the user still has an identity of this kind under the same master key. */
  async #refresh(target: Record<string, string>): Promise<void> {
    const kind = this.#json?.kind;
    try {
      const next = await this.#call('getIdentity', { userId: this.#userId });
      this.#json =
        isIdentity(next) &&
        (next as IdentityJson).kind === kind &&
        publicMasterKey((next as IdentityJson).masterKey) ===
          target['masterKey']
          ? (next as T)
          : undefined;
    } catch {
      this.#json = undefined;
    }
  }
}

function publicMasterKey(masterKeyJson: string): string | undefined {
  try {
    const keys = (JSON.parse(masterKeyJson) as { keys?: unknown }).keys;
    const key = isObject(keys) ? Object.values(keys)[0] : undefined;
    return typeof key === 'string' ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * WASM `OwnUserIdentity` (matrix-js-sdk tells the kinds apart with `instanceof`). Not here:
 * `requestVerification` (slice 4) and `trustsOurOwnDevice`.
 */
export class NativeOwnUserIdentity {
  readonly #snapshot: IdentitySnapshot<OwnJson>;

  public constructor(json: OwnJson, userId: string, call: MachineCall) {
    this.#snapshot = new IdentitySnapshot(
      json,
      userId,
      call,
      'OwnUserIdentity',
    );
  }

  public get masterKey(): string {
    return this.#snapshot.read('masterKey').masterKey;
  }

  public get selfSigningKey(): string {
    return this.#snapshot.read('selfSigningKey').selfSigningKey;
  }

  public get userSigningKey(): string {
    return this.#snapshot.read('userSigningKey').userSigningKey;
  }

  public isVerified(): boolean {
    return this.#snapshot.read('isVerified').isVerified;
  }

  public wasPreviouslyVerified(): boolean {
    return this.#snapshot.read('wasPreviouslyVerified').wasPreviouslyVerified;
  }

  public hasVerificationViolation(): boolean {
    return this.#snapshot.read('hasVerificationViolation')
      .hasVerificationViolation;
  }

  /** WASM marks the own identity verified on the object itself, then signs. */
  public verify(): Promise<SignatureUploadRequest> {
    return this.#snapshot.verify(true);
  }

  public withdrawVerification(): Promise<void> {
    return this.#snapshot.change('withdrawVerification');
  }

  public free(): void {
    return undefined;
  }
}
standIn(NativeOwnUserIdentity, OwnUserIdentity);

/**
 * WASM `OtherUserIdentity`; it has no `userSigningKey`, which matrix-js-sdk tests with `in`.
 * Not here: `requestVerification` and `verificationRequestContent` (slice 4).
 */
export class NativeOtherUserIdentity {
  readonly #snapshot: IdentitySnapshot<OtherJson>;

  public constructor(json: OtherJson, userId: string, call: MachineCall) {
    this.#snapshot = new IdentitySnapshot(
      json,
      userId,
      call,
      'OtherUserIdentity',
    );
  }

  public get masterKey(): string {
    return this.#snapshot.read('masterKey').masterKey;
  }

  public get selfSigningKey(): string {
    return this.#snapshot.read('selfSigningKey').selfSigningKey;
  }

  public isVerified(): boolean {
    return this.#snapshot.read('isVerified').isVerified;
  }

  public wasPreviouslyVerified(): boolean {
    return this.#snapshot.read('wasPreviouslyVerified').wasPreviouslyVerified;
  }

  public hasVerificationViolation(): boolean {
    return this.#snapshot.read('hasVerificationViolation')
      .hasVerificationViolation;
  }

  public identityNeedsUserApproval(): boolean {
    return this.#snapshot.read('identityNeedsUserApproval')
      .identityNeedsUserApproval;
  }

  /** Only signs: WASM's object keeps its answers until the identity is read again. */
  public verify(): Promise<SignatureUploadRequest> {
    return this.#snapshot.verify(false);
  }

  public withdrawVerification(): Promise<void> {
    return this.#snapshot.change('withdrawVerification');
  }

  public pinCurrentMasterKey(): Promise<void> {
    return this.#snapshot.change('pinCurrentMasterKey');
  }

  public free(): void {
    return undefined;
  }
}
standIn(NativeOtherUserIdentity, OtherUserIdentity);

export function toIdentity(
  json: IdentityJson,
  userId: string,
  call: MachineCall,
): OwnUserIdentity | OtherUserIdentity {
  return (json.kind === 'own'
    ? new NativeOwnUserIdentity(json as OwnJson, userId, call)
    : new NativeOtherUserIdentity(
        json as OtherJson,
        userId,
        call,
      )) as unknown as OwnUserIdentity | OtherUserIdentity;
}

/**
 * WASM `BackupKeys`. It holds the key as a real `BackupDecryptionKey` (wasm memory, as WASM's
 * object does) and hands out a copy on each read, as WASM's getter does: matrix-js-sdk frees
 * the decryptors it builds from one. `free` releases it.
 */
export class NativeBackupKeys {
  #key: BackupDecryptionKey | undefined;
  readonly #version: string | undefined;

  public constructor(key: BackupDecryptionKey | undefined, version?: string) {
    this.#key = key;
    this.#version = version;
  }

  public get decryptionKey(): BackupDecryptionKey | undefined {
    return this.#key && BackupDecryptionKey.fromBase64(this.#key.toBase64());
  }

  public get backupVersion(): string | undefined {
    return this.#version;
  }

  public free(): void {
    this.#key?.free();
    this.#key = undefined;
  }
}
standIn(NativeBackupKeys, BackupKeys);
