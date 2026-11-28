// Devices, user identities and backup keys on the native crate. The crate answers each with a
// snapshot of every getter matrix-js-sdk reads (native/crypto/README.md); the stand-ins below
// answer those reads synchronously from it, as WASM's objects do from the store data they were
// read with, and forward every method as a call that carries the key the snapshot was read with,
// so the crate refuses (`StaleObject`) to act on a device or identity that changed since.
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

export const isDevice = (value: unknown): boolean =>
  isObject(value) &&
  typeof value['userId'] === 'string' &&
  typeof value['deviceId'] === 'string' &&
  (value['displayName'] === undefined ||
    typeof value['displayName'] === 'string') &&
  isStringRecord(value['keys']) &&
  Array.isArray(value['algorithms']) &&
  isObject(value['signatures']) &&
  typeof value['localTrustState'] === 'number' &&
  DEVICE_FLAGS.every((flag) => typeof value[flag] === 'boolean');

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
  readonly #json: DeviceJson;
  readonly #call: MachineCall;

  public constructor(json: DeviceJson, call: MachineCall) {
    this.#json = json;
    this.#call = call;
  }

  /** The device the call acts on, as this snapshot read it; refused without its ed25519 key. */
  #target(method: string): Record<string, string> {
    const { userId, deviceId, keys } = this.#json;
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

  public get userId(): UserId {
    return new UserId(this.#json.userId);
  }

  public get deviceId(): DeviceId {
    return new DeviceId(this.#json.deviceId);
  }

  public get displayName(): string | undefined {
    return this.#json.displayName;
  }

  public get keys(): Map<DeviceKeyId, DeviceKey> {
    return new Map(
      Object.entries(this.#json.keys).map(([id, key]) => [
        new DeviceKeyId(id),
        wasmValue(DeviceKey, { toBase64: () => key }),
      ]),
    );
  }

  public get algorithms(): EncryptionAlgorithm[] {
    return [...this.#json.algorithms];
  }

  /** Only `get(signer)` is answered, the one member matrix-js-sdk reads. */
  public get signatures(): Signatures {
    const signatures = this.#json.signatures;
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
    return this.#json.localTrustState;
  }

  public get isDehydrated(): boolean {
    return this.#json.isDehydrated;
  }

  public isVerified(): boolean {
    return this.#json.isVerified;
  }

  public isCrossSigningTrusted(): boolean {
    return this.#json.isCrossSigningTrusted;
  }

  public isCrossSignedByOwner(): boolean {
    return this.#json.isCrossSignedByOwner;
  }

  public isLocallyTrusted(): boolean {
    return this.#json.isLocallyTrusted;
  }

  public isBlacklisted(): boolean {
    return this.#json.isBlacklisted;
  }

  public isDeleted(): boolean {
    return this.#json.isDeleted;
  }

  public async setLocalTrust(localState: LocalTrust): Promise<null> {
    await this.#call('setLocalTrust', {
      ...this.#target('setLocalTrust'),
      localState,
    });
    return null;
  }

  public async verify(): Promise<SignatureUploadRequest> {
    return toRequest(
      checked<RequestJson>(
        'verifyDevice',
        await this.#call('verifyDevice', this.#target('verifyDevice')),
        isObject,
      ),
    ) as SignatureUploadRequest;
  }

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

/**
 * The identity a call acts on, as the snapshot read it: its user and the public master key
 * (the one key of the `masterKey` JSON); refused when the snapshot holds none.
 */
function identityTarget(
  method: string,
  userId: string,
  masterKeyJson: string,
): Record<string, string> {
  let masterKey: unknown;
  try {
    const keys = (JSON.parse(masterKeyJson) as { keys?: unknown }).keys;
    masterKey = isObject(keys) ? Object.values(keys)[0] : undefined;
  } catch {
    masterKey = undefined;
  }
  if (typeof masterKey !== 'string') {
    throw new NativeCryptoError(
      method,
      'UnexpectedAnswer',
      'the identity has no master key',
    );
  }
  return { userId, masterKey };
}

async function verifyIdentity(
  call: MachineCall,
  userId: string,
  masterKey: string,
): Promise<SignatureUploadRequest> {
  return toRequest(
    checked<RequestJson>(
      'verifyIdentity',
      await call(
        'verifyIdentity',
        identityTarget('verifyIdentity', userId, masterKey),
      ),
      isObject,
    ),
  ) as SignatureUploadRequest;
}

async function withdrawVerification(
  call: MachineCall,
  userId: string,
  masterKey: string,
): Promise<void> {
  await call(
    'withdrawVerification',
    identityTarget('withdrawVerification', userId, masterKey),
  );
}

/**
 * WASM `OwnUserIdentity` (matrix-js-sdk tells the kinds apart with `instanceof`). Not here:
 * `requestVerification` (slice 4) and `trustsOurOwnDevice`.
 */
export class NativeOwnUserIdentity {
  readonly #json: IdentityJson & { readonly userSigningKey: string };
  readonly #userId: string;
  readonly #call: MachineCall;

  public constructor(
    json: IdentityJson & { readonly userSigningKey: string },
    userId: string,
    call: MachineCall,
  ) {
    this.#json = json;
    this.#userId = userId;
    this.#call = call;
  }

  public get masterKey(): string {
    return this.#json.masterKey;
  }

  public get selfSigningKey(): string {
    return this.#json.selfSigningKey;
  }

  public get userSigningKey(): string {
    return this.#json.userSigningKey;
  }

  public isVerified(): boolean {
    return this.#json.isVerified;
  }

  public wasPreviouslyVerified(): boolean {
    return this.#json.wasPreviouslyVerified;
  }

  public hasVerificationViolation(): boolean {
    return this.#json.hasVerificationViolation;
  }

  public verify(): Promise<SignatureUploadRequest> {
    return verifyIdentity(this.#call, this.#userId, this.#json.masterKey);
  }

  public withdrawVerification(): Promise<void> {
    return withdrawVerification(this.#call, this.#userId, this.#json.masterKey);
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
  readonly #json: IdentityJson & {
    readonly identityNeedsUserApproval: boolean;
  };
  readonly #userId: string;
  readonly #call: MachineCall;

  public constructor(
    json: IdentityJson & { readonly identityNeedsUserApproval: boolean },
    userId: string,
    call: MachineCall,
  ) {
    this.#json = json;
    this.#userId = userId;
    this.#call = call;
  }

  public get masterKey(): string {
    return this.#json.masterKey;
  }

  public get selfSigningKey(): string {
    return this.#json.selfSigningKey;
  }

  public isVerified(): boolean {
    return this.#json.isVerified;
  }

  public wasPreviouslyVerified(): boolean {
    return this.#json.wasPreviouslyVerified;
  }

  public hasVerificationViolation(): boolean {
    return this.#json.hasVerificationViolation;
  }

  public identityNeedsUserApproval(): boolean {
    return this.#json.identityNeedsUserApproval;
  }

  public verify(): Promise<SignatureUploadRequest> {
    return verifyIdentity(this.#call, this.#userId, this.#json.masterKey);
  }

  public withdrawVerification(): Promise<void> {
    return withdrawVerification(this.#call, this.#userId, this.#json.masterKey);
  }

  public async pinCurrentMasterKey(): Promise<void> {
    await this.#call(
      'pinCurrentMasterKey',
      identityTarget('pinCurrentMasterKey', this.#userId, this.#json.masterKey),
    );
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
    ? new NativeOwnUserIdentity(
        json as IdentityJson & { userSigningKey: string },
        userId,
        call,
      )
    : new NativeOtherUserIdentity(
        json as IdentityJson & { identityNeedsUserApproval: boolean },
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
