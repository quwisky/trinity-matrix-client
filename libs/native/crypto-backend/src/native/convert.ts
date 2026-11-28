// Between the crate's JSON (native/crypto/README.md) and the WASM package's objects. Classes
// JavaScript can construct stay real WASM objects; the others are guarded value objects.
import {
  CollectStrategy,
  CrossSigningBootstrapRequests,
  CrossSigningKeyExport,
  CrossSigningStatus,
  Curve25519PublicKey,
  DecryptedRoomEvent,
  DecryptedToDeviceEvent,
  DeviceId,
  Ed25519PublicKey,
  EncryptionInfo,
  type EncryptionSettings,
  IdentityKeys,
  InvalidToDeviceEvent,
  KeysBackupRequest,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysUploadRequest,
  MegolmDecryptionError,
  type OutgoingRequest,
  PlainTextToDeviceEvent,
  type ProcessedToDeviceEvent,
  RequestType,
  RoomId,
  RoomKeyCounts,
  RoomKeyImportResult,
  RoomKeyInfo,
  RoomKeyWithheldInfo,
  RoomMessageRequest,
  RoomPendingKeyBundleDetails,
  RoomSettings,
  SecretsBundle,
  ShieldState,
  Signatures,
  SignatureUploadRequest,
  SignatureVerification,
  StoredRoomKeyBundleData,
  ToDeviceEncryptionInfo,
  ToDeviceRequest,
  ToDeviceUnableToDecryptInfo,
  UploadSigningKeysRequest,
  UserId,
  UTDToDeviceEvent,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import { standIn, wasmValue } from './guard';
import { isObject } from './types';

/** Standard base64, in chunks: a spread of a large array would overflow the stack. */
export function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  let text = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(text);
}

export function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export interface RequestJson {
  readonly id?: string;
  readonly type: number;
  readonly body: string;
  readonly event_type?: string;
  readonly txn_id?: string;
  readonly room_id?: string;
  readonly version?: string;
}

const required = (
  value: string | undefined,
  field: string,
  type: number,
): string => {
  if (value === undefined)
    throw new Error(`native crypto request of type ${type} has no ${field}`);
  return value;
};

/** A request of the crate as the real WASM class matrix-js-sdk dispatches on with `instanceof`. */
export function toRequest(json: RequestJson): OutgoingRequest {
  const id = json.id ?? '';
  const field = (value: string | undefined, name: string) =>
    required(value, name, json.type);
  switch (json.type) {
    case RequestType.KeysUpload:
      return new KeysUploadRequest(id, json.body);
    case RequestType.KeysQuery:
      return new KeysQueryRequest(id, json.body);
    case RequestType.KeysClaim:
      return new KeysClaimRequest(id, json.body);
    case RequestType.ToDevice:
      return new ToDeviceRequest(
        id,
        field(json.event_type, 'event_type'),
        field(json.txn_id, 'txn_id'),
        json.body,
      );
    case RequestType.SignatureUpload:
      return new SignatureUploadRequest(id, json.body);
    case RequestType.RoomMessage:
      return new RoomMessageRequest(
        id,
        field(json.room_id, 'room_id'),
        field(json.txn_id, 'txn_id'),
        field(json.event_type, 'event_type'),
        json.body,
      );
    case RequestType.KeysBackup:
      return new KeysBackupRequest(
        id,
        json.body,
        field(json.version, 'version'),
      );
    default:
      throw new Error(
        `native crypto returned a request of unknown type ${json.type}`,
      );
  }
}

const STRATEGIES = [
  ['allDevices', CollectStrategy.allDevices],
  ['onlyTrustedDevices', CollectStrategy.onlyTrustedDevices],
  [
    'errorOnUnverifiedUserProblem',
    CollectStrategy.errorOnUnverifiedUserProblem,
  ],
  ['identityBasedStrategy', CollectStrategy.identityBasedStrategy],
] as const;

/**
 * The crate's name for a strategy. WASM's `eq` decides, so `deviceBasedStrategy` maps exactly as
 * WASM maps it (native/crypto/surface.json, `shimNotes`).
 */
export function strategyName(strategy: CollectStrategy): string {
  for (const [name, make] of STRATEGIES) {
    const candidate = make();
    try {
      if (strategy.eq(candidate)) return name;
    } finally {
      candidate.free();
    }
  }
  throw new Error('native crypto does not know this sharing strategy');
}

export function encryptionSettingsJson(
  settings: EncryptionSettings,
): Record<string, unknown> {
  const strategy = settings.sharingStrategy;
  try {
    return {
      algorithm: settings.algorithm,
      encryptStateEvents: settings.encryptStateEvents,
      historyVisibility: settings.historyVisibility,
      rotationPeriod: Number(settings.rotationPeriod),
      rotationPeriodMessages: Number(settings.rotationPeriodMessages),
      sharingStrategy: strategyName(strategy),
    };
  } finally {
    strategy.free();
  }
}

export interface RoomSettingsJson {
  readonly algorithm: number;
  readonly encryptStateEvents: boolean;
  readonly onlyAllowTrustedDevices: boolean;
  readonly sessionRotationPeriodMs?: number;
  readonly sessionRotationPeriodMessages?: number;
}

export function toRoomSettings(json: RoomSettingsJson): RoomSettings {
  const settings = new RoomSettings();
  settings.algorithm = json.algorithm;
  settings.encryptStateEvents = json.encryptStateEvents;
  settings.onlyAllowTrustedDevices = json.onlyAllowTrustedDevices;
  settings.sessionRotationPeriodMs = json.sessionRotationPeriodMs;
  settings.sessionRotationPeriodMessages = json.sessionRotationPeriodMessages;
  return settings;
}

export function roomSettingsJson(settings: RoomSettings): RoomSettingsJson {
  return {
    algorithm: settings.algorithm,
    encryptStateEvents: settings.encryptStateEvents,
    onlyAllowTrustedDevices: settings.onlyAllowTrustedDevices,
    ...(settings.sessionRotationPeriodMs === undefined
      ? {}
      : { sessionRotationPeriodMs: settings.sessionRotationPeriodMs }),
    ...(settings.sessionRotationPeriodMessages === undefined
      ? {}
      : {
          sessionRotationPeriodMessages: settings.sessionRotationPeriodMessages,
        }),
  };
}

interface ShieldJson {
  readonly color: number;
  readonly code?: number;
  readonly message?: string;
}

export interface EncryptionInfoJson {
  readonly sender: string;
  readonly senderDevice?: string;
  readonly forwarder?: string;
  readonly forwarderDevice?: string;
  readonly senderCurve25519Key: string;
  readonly senderClaimedEd25519Key?: string;
  readonly shieldState: {
    readonly lax: ShieldJson;
    readonly strict: ShieldJson;
  };
}

const shieldState = ({ color, code, message }: ShieldJson) =>
  wasmValue(ShieldState, { color, code, message });

const optional = <T>(
  value: string | undefined,
  make: new (value: string) => T,
) => (value === undefined ? undefined : new make(value));

const encryptionInfoFields = (json: EncryptionInfoJson) => ({
  sender: new UserId(json.sender),
  senderDevice: optional(json.senderDevice, DeviceId),
  forwarder: optional(json.forwarder, UserId),
  forwarderDevice: optional(json.forwarderDevice, DeviceId),
  senderCurve25519Key: json.senderCurve25519Key,
  senderClaimedEd25519Key: json.senderClaimedEd25519Key,
  shieldState: (strict: boolean) =>
    shieldState(strict ? json.shieldState.strict : json.shieldState.lax),
});

export function toEncryptionInfo(json: EncryptionInfoJson): EncryptionInfo {
  return wasmValue(EncryptionInfo, encryptionInfoFields(json));
}

export function toDecryptedRoomEvent(
  json: EncryptionInfoJson & {
    readonly event: string;
    readonly forwardingCurve25519KeyChain: string[];
  },
): DecryptedRoomEvent {
  return wasmValue(DecryptedRoomEvent, {
    ...encryptionInfoFields(json),
    event: json.event,
    forwardingCurve25519KeyChain: json.forwardingCurve25519KeyChain,
  });
}

export interface MegolmErrorDetails {
  readonly code: number;
  readonly description: string;
  readonly withheldCode?: string;
  readonly maybe_withheld?: string;
}

/** What WASM throws from `decryptRoomEvent`; matrix-js-sdk checks it with `instanceof`. */
export function toMegolmDecryptionError(
  details: MegolmErrorDetails,
): MegolmDecryptionError {
  return wasmValue(MegolmDecryptionError, {
    code: details.code,
    description: details.description,
    withheldCode: details.withheldCode,
    maybe_withheld: details.maybe_withheld,
  });
}

interface ToDeviceJson {
  readonly type: number;
  readonly rawEvent: string;
  readonly encryptionInfo?: {
    readonly sender: string;
    readonly senderDevice?: string;
    readonly senderCurve25519Key: string;
    readonly isSenderVerified: boolean;
  };
  readonly utdInfo?: { readonly reason: number };
}

export function toProcessedToDeviceEvent(
  json: ToDeviceJson,
): ProcessedToDeviceEvent {
  const { type, rawEvent } = json;
  if (json.encryptionInfo) {
    const info = json.encryptionInfo;
    return wasmValue(DecryptedToDeviceEvent, {
      type,
      rawEvent,
      encryptionInfo: wasmValue(ToDeviceEncryptionInfo, {
        sender: new UserId(info.sender),
        senderDevice: optional(info.senderDevice, DeviceId),
        senderCurve25519Key: info.senderCurve25519Key,
        isSenderVerified: () => info.isSenderVerified,
      }),
    });
  }
  if (json.utdInfo) {
    return wasmValue(UTDToDeviceEvent, {
      type,
      rawEvent,
      utdInfo: wasmValue(ToDeviceUnableToDecryptInfo, {
        reason: json.utdInfo.reason,
      }),
    });
  }
  return wasmValue(type === 2 ? PlainTextToDeviceEvent : InvalidToDeviceEvent, {
    type,
    rawEvent,
  });
}

interface RoomKeyJson {
  readonly algorithm: number;
  readonly roomId: string;
  readonly senderKey: string;
  readonly sessionId: string;
}

export function toRoomKeyInfo(json: RoomKeyJson): RoomKeyInfo {
  return wasmValue(RoomKeyInfo, {
    algorithm: json.algorithm,
    roomId: new RoomId(json.roomId),
    senderKey: new Curve25519PublicKey(json.senderKey),
    sessionId: json.sessionId,
  });
}

interface WithheldJson {
  readonly sender: string;
  readonly algorithm: number;
  readonly withheldCode: string;
  readonly roomId: string;
  readonly sessionId: string;
}

export function toRoomKeyWithheldInfo(json: WithheldJson): RoomKeyWithheldInfo {
  return wasmValue(RoomKeyWithheldInfo, {
    sender: new UserId(json.sender),
    algorithm: json.algorithm,
    withheldCode: json.withheldCode,
    roomId: new RoomId(json.roomId),
    sessionId: json.sessionId,
  });
}

export function toIdentityKeys(json: {
  readonly ed25519: string;
  readonly curve25519: string;
}): IdentityKeys {
  return wasmValue(IdentityKeys, {
    curve25519: new Curve25519PublicKey(json.curve25519),
    ed25519: wasmValue(Ed25519PublicKey, { toBase64: () => json.ed25519 }),
  });
}

export interface PendingBundleJson {
  readonly roomId: string;
  readonly inviterId: string;
  readonly inviteAcceptedAtMillis: number;
}

export function toPendingBundle(
  json: PendingBundleJson,
): RoomPendingKeyBundleDetails {
  return wasmValue(RoomPendingKeyBundleDetails, {
    roomId: new RoomId(json.roomId),
    inviterId: new UserId(json.inviterId),
    inviteAcceptedAtMillis: json.inviteAcceptedAtMillis,
  });
}

export interface CrossSigningStatusJson {
  readonly hasMaster: boolean;
  readonly hasSelfSigning: boolean;
  readonly hasUserSigning: boolean;
}

export const isCrossSigningStatus = (value: unknown): boolean =>
  isObject(value) &&
  ['hasMaster', 'hasSelfSigning', 'hasUserSigning'].every(
    (flag) => typeof value[flag] === 'boolean',
  );

export const toCrossSigningStatus = (
  json: CrossSigningStatusJson,
): CrossSigningStatus =>
  wasmValue(CrossSigningStatus, {
    hasMaster: json.hasMaster,
    hasSelfSigning: json.hasSelfSigning,
    hasUserSigning: json.hasUserSigning,
  });

export interface CrossSigningKeyExportJson {
  readonly masterKey?: string;
  readonly self_signing_key?: string;
  readonly userSigningKey?: string;
}

const EXPORTED_KEYS = ['masterKey', 'self_signing_key', 'userSigningKey'];

export const isCrossSigningKeyExport = (value: unknown): boolean =>
  isObject(value) &&
  Object.entries(value).every(
    ([name, key]) => EXPORTED_KEYS.includes(name) && typeof key === 'string',
  );

/** The private cross-signing keys, under WASM's getter names (`self_signing_key` too), hidden. */
export const toCrossSigningKeyExport = (
  json: CrossSigningKeyExportJson,
): CrossSigningKeyExport =>
  wasmValue(
    CrossSigningKeyExport,
    {},
    {
      masterKey: json.masterKey,
      self_signing_key: json.self_signing_key,
      userSigningKey: json.userSigningKey,
    },
  );

export const isBootstrapRequests = (value: unknown): boolean =>
  isObject(value) &&
  (value['uploadKeysRequest'] === undefined ||
    (isObject(value['uploadKeysRequest']) &&
      value['uploadKeysRequest']['type'] === RequestType.KeysUpload &&
      typeof value['uploadKeysRequest']['id'] === 'string' &&
      typeof value['uploadKeysRequest']['body'] === 'string')) &&
  isObject(value['uploadSigningKeysRequest']) &&
  typeof value['uploadSigningKeysRequest']['body'] === 'string' &&
  isObject(value['uploadSignaturesRequest']) &&
  value['uploadSignaturesRequest']['type'] === RequestType.SignatureUpload &&
  typeof value['uploadSignaturesRequest']['body'] === 'string';

export const toBootstrapRequests = (json: {
  readonly uploadKeysRequest?: RequestJson;
  readonly uploadSigningKeysRequest: { readonly body: string };
  readonly uploadSignaturesRequest: RequestJson;
}): CrossSigningBootstrapRequests =>
  wasmValue(CrossSigningBootstrapRequests, {
    uploadKeysRequest: json.uploadKeysRequest
      ? toRequest(json.uploadKeysRequest)
      : undefined,
    uploadSigningKeysRequest: new UploadSigningKeysRequest(
      json.uploadSigningKeysRequest.body,
    ),
    uploadSignaturesRequest: toRequest(json.uploadSignaturesRequest),
  });

export const toRoomKeyCounts = (json: {
  readonly total: number;
  readonly backedUp: number;
}): RoomKeyCounts =>
  wasmValue(RoomKeyCounts, { total: json.total, backedUp: json.backedUp });

/** `trusted` is the crate's answer to WASM's `trusted()`. */
export const toSignatureVerification = (json: {
  readonly deviceState: number;
  readonly userState: number;
  readonly trusted: boolean;
}): SignatureVerification =>
  wasmValue(SignatureVerification, {
    deviceState: json.deviceState,
    userState: json.userState,
    trusted: () => json.trusted,
  });

/** What `sign` returns: only `asJSON()`, the one member matrix-js-sdk reads. */
export const toSignatures = (json: unknown): Signatures =>
  wasmValue(Signatures, { asJSON: () => JSON.stringify(json) });

export interface ImportResultJson {
  readonly importedCount: number;
  readonly totalCount: number;
  readonly keys: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
  /** The arguments of WASM's last progress listener call, or `null` when it made none. */
  readonly lastProgress: readonly number[] | null;
}

export const isImportResult = (value: unknown): boolean =>
  isObject(value) &&
  typeof value['importedCount'] === 'number' &&
  typeof value['totalCount'] === 'number' &&
  isObject(value['keys']) &&
  (value['lastProgress'] === null ||
    (Array.isArray(value['lastProgress']) &&
      value['lastProgress'].every((entry) => typeof entry === 'number')));

export const toImportResult = (json: ImportResultJson): RoomKeyImportResult =>
  wasmValue(RoomKeyImportResult, {
    importedCount: json.importedCount,
    totalCount: json.totalCount,
    keys: () =>
      new Map(
        Object.entries(json.keys).map(([room, senders]) => [
          room,
          new Map(
            Object.entries(senders).map(([sender, sessions]) => [
              sender,
              new Set(sessions),
            ]),
          ),
        ]),
      ),
  });

const isSeed = (value: unknown) => typeof value === 'string';

/** What `SecretsBundle.to_json()` gives: the private cross-signing seeds and maybe the backup key. */
export const isSecretsBundle = (value: unknown): boolean =>
  isObject(value) &&
  isObject(value['cross_signing']) &&
  ['master_key', 'self_signing_key', 'user_signing_key'].every((name) =>
    isSeed((value['cross_signing'] as Record<string, unknown>)[name]),
  ) &&
  (value['backup'] === undefined || isObject(value['backup']));

/**
 * WASM `SecretsBundle` from `exportSecretsBundle`: `to_json()` gives the crate's JSON back, as
 * WASM's does, and `free()` drops it. The secrets sit in a private field, out of reach of
 * `JSON.stringify` and `console.log`.
 */
export class NativeSecretsBundle {
  #json: unknown;

  public constructor(json: unknown) {
    this.#json = json;
  }

  public to_json(): unknown {
    if (this.#json === undefined) {
      throw new Error('native crypto: the secrets bundle was freed');
    }
    return this.#json;
  }

  public free(): void {
    this.#json = undefined;
  }
}
standIn(NativeSecretsBundle, SecretsBundle);

export interface BundleDataJson {
  readonly senderUser: string;
  readonly roomId: string;
  readonly url: string;
  readonly encryptionInfo: string;
}

export const isBundleData = (value: unknown): boolean =>
  isObject(value) &&
  ['senderUser', 'roomId', 'url', 'encryptionInfo'].every(
    (field) => typeof value[field] === 'string',
  );

/** WASM `StoredRoomKeyBundleData`; the file key in `encryptionInfo` is hidden as a secret. */
export const toBundleData = (json: BundleDataJson): StoredRoomKeyBundleData =>
  wasmValue(
    StoredRoomKeyBundleData,
    {
      senderUser: new UserId(json.senderUser),
      roomId: new RoomId(json.roomId),
      url: json.url,
    },
    { encryptionInfo: json.encryptionInfo },
  );
