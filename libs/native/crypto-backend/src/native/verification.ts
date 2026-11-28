// Interactive verification on the native crate. The crate answers a verification request, SAS or
// QR code with a snapshot of every getter (native/crypto/README.md, "Verification") and reports
// each change as an event carrying the full snapshot. The stand-ins below are live mirrors: one
// per flow and kind, kept in a registry, updated from those events while the batch that caused
// them is delivered (before its calls resolve), and every getter matrix-js-sdk reads
// synchronously answers from the mirror. `registerChangesCallback` callbacks run on each change
// event, in order, as WASM runs them once per change it sees.
//
// A flow's SAS or QR code can be replaced under the same flow ID (a QR code by a SAS, a SAS by
// the other side's start that won the tie, a shown QR code by a scanned one). Upstream changes
// the request each time, and a request changes while in Transitioned only for such a
// replacement, so a request event that finds the mirror already Transitioned gets a new stand-in
// for its verification: matrix-js-sdk then sees another object from `getVerification()`, as on
// WASM, and switches (`replaceInner` re-accepts the SAS that won). A replaced stand-in refuses
// every call (`StaleObject`): the crate would act on the flow's new verification, where WASM's
// object acts on the old one.
//
// The registry is the answer of `getVerificationRequest(s)`, which matrix-js-sdk calls
// synchronously. It holds every request the crate handed out; incoming requests are fetched by
// the machine before the sync input or in-room event that brought them resolves. A flow that is
// done or cancelled stays until the next sync input, when upstream collects it too; `close`, a
// reload and a lost machine clear the registry (verifications live in the machine's memory).
import {
  CancelInfo,
  DeviceId,
  Emoji,
  type OutgoingRequest,
  Qr,
  type QrState,
  RequestType,
  RoomId,
  Sas,
  UserId,
  type VerificationMethod,
  VerificationRequest,
  type VerificationRequestPhase,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import {
  base64ToBytes,
  bytesToBase64,
  type RequestJson,
  toRequest,
} from './convert';
import { standIn, wasmValue } from './guard';
import type { MachineCall } from './trust';
import {
  checked,
  describeError,
  isObject,
  NativeCryptoError,
  type NativeCryptoLogger,
} from './types';

/** WASM `VerificationRequestPhase.Transitioned`. */
const TRANSITIONED = 3;

interface CancelInfoJson {
  readonly cancelCode: string;
  readonly reason: string;
  readonly cancelledbyUs: boolean;
}

interface FlowJson {
  readonly otherUserId: string;
  readonly flowId: string;
  readonly roomId?: string;
  readonly isDone: boolean;
  readonly isCancelled: boolean;
  readonly cancelInfo?: CancelInfoJson;
}

export interface RequestSnapshot extends FlowJson {
  readonly kind: 'request';
  readonly otherDeviceId?: string;
  readonly phase: VerificationRequestPhase;
  readonly isPassive: boolean;
  readonly isSelfVerification: boolean;
  readonly weStarted: boolean;
  readonly timedOut: boolean;
  readonly expiresAtMs: number;
  readonly theirSupportedMethods?: readonly VerificationMethod[];
  readonly verification?: SasSnapshot | QrSnapshot;
}

export interface SasSnapshot extends FlowJson {
  readonly kind: 'sas';
  readonly emoji?: readonly {
    readonly symbol: string;
    readonly description: string;
  }[];
  readonly decimals?: readonly number[];
}

export interface QrSnapshot extends FlowJson {
  readonly kind: 'qr';
  readonly state: QrState;
  readonly hasBeenScanned: boolean;
}

export type Snapshot = RequestSnapshot | SasSnapshot | QrSnapshot;

const isCancelInfo = (value: unknown) =>
  value === undefined ||
  (isObject(value) &&
    typeof value['cancelCode'] === 'string' &&
    typeof value['reason'] === 'string' &&
    typeof value['cancelledbyUs'] === 'boolean');

const isFlow = (value: unknown): value is Record<string, unknown> =>
  isObject(value) &&
  typeof value['otherUserId'] === 'string' &&
  typeof value['flowId'] === 'string' &&
  (value['roomId'] === undefined || typeof value['roomId'] === 'string') &&
  typeof value['isDone'] === 'boolean' &&
  typeof value['isCancelled'] === 'boolean' &&
  isCancelInfo(value['cancelInfo']);

const isNumbers = (value: unknown) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'number');

const isSasSnapshot = (value: unknown): boolean =>
  isFlow(value) &&
  value['kind'] === 'sas' &&
  (value['emoji'] === undefined ||
    (Array.isArray(value['emoji']) &&
      value['emoji'].every(
        (emoji) =>
          isObject(emoji) &&
          typeof emoji['symbol'] === 'string' &&
          typeof emoji['description'] === 'string',
      ))) &&
  (value['decimals'] === undefined ||
    (isNumbers(value['decimals']) &&
      (value['decimals'] as unknown[]).length === 3));

const isQrSnapshot = (value: unknown): boolean =>
  isFlow(value) &&
  value['kind'] === 'qr' &&
  typeof value['state'] === 'number' &&
  typeof value['hasBeenScanned'] === 'boolean';

export const isVerificationSnapshot = (value: unknown): boolean =>
  isSasSnapshot(value) || isQrSnapshot(value);

export const isRequestSnapshot = (value: unknown): boolean =>
  isFlow(value) &&
  value['kind'] === 'request' &&
  (value['otherDeviceId'] === undefined ||
    typeof value['otherDeviceId'] === 'string') &&
  typeof value['phase'] === 'number' &&
  ['isPassive', 'isSelfVerification', 'weStarted', 'timedOut'].every(
    (flag) => typeof value[flag] === 'boolean',
  ) &&
  typeof value['expiresAtMs'] === 'number' &&
  (value['theirSupportedMethods'] === undefined ||
    isNumbers(value['theirSupportedMethods'])) &&
  (value['verification'] === undefined ||
    isVerificationSnapshot(value['verification']));

/** A verification call's answer: the to-device or in-room message to send, or `null`. */
const isOutgoing = (value: unknown) =>
  value === null ||
  (isObject(value) &&
    (value['type'] === RequestType.ToDevice ||
      value['type'] === RequestType.RoomMessage) &&
    typeof value['body'] === 'string');

const outgoing = (method: string, answer: unknown) => {
  const request = checked<RequestJson | null>(method, answer, isOutgoing);
  return request ? toRequest(request) : undefined;
};

/** Crate answers that change with time alone; a snapshot is the same object state without them. */
const state = ({
  expiresAtMs: _expires,
  timedOut: _timedOut,
  ...rest
}: Record<string, unknown>) => JSON.stringify(rest);

const keyOf = (otherUserId: string, flowId: string) =>
  JSON.stringify([otherUserId, flowId]);

const toCancelInfo = (json: CancelInfoJson | undefined) =>
  json &&
  wasmValue(CancelInfo, {
    cancelCode: () => json.cancelCode,
    reason: () => json.reason,
    cancelledbyUs: () => json.cancelledbyUs,
  });

const stale = (member: string): NativeCryptoError =>
  new NativeCryptoError(
    member,
    'StaleObject',
    'a newer verification replaced this one on its flow; use the request again',
  );

type Callback = () => Promise<void>;

/** What every mirror shares: its snapshot, its callbacks, and its flow's calls. */
export abstract class Mirror<T extends Snapshot> {
  protected json: T;
  protected readonly registry: Verifications;
  readonly #callbacks: Callback[] = [];

  public constructor(json: T, registry: Verifications) {
    this.json = json;
    this.registry = registry;
  }

  public get key(): string {
    return keyOf(this.json.otherUserId, this.json.flowId);
  }

  /** Done or cancelled: no change can follow. */
  public get final(): boolean {
    return this.json.isDone || this.json.isCancelled;
  }

  /** Takes a newer snapshot; whether its callbacks run is the caller's choice (see `notify`). */
  public update(json: T): void {
    this.json = json;
  }

  public same(json: T): boolean {
    return state(json as never) === state(this.json as never);
  }

  public notify(): void {
    for (const callback of [...this.#callbacks]) {
      try {
        Promise.resolve(callback()).catch((error: unknown) =>
          this.registry.warn(
            `a verification callback failed: ${describeError(error)}`,
          ),
        );
      } catch (error) {
        this.registry.warn(
          `a verification callback failed: ${describeError(error)}`,
        );
      }
    }
  }

  public registerChangesCallback(callback: Callback): void {
    this.#callbacks.push(callback);
  }

  /** The other user and the flow: what every call on the flow takes. */
  protected flow(): Record<string, string> {
    return { userId: this.json.otherUserId, flowId: this.json.flowId };
  }

  /**
   * An acting call. On a flow it saw done or cancelled, the crate's `UnknownVerification` (the
   * flow was collected) answers "no request", as WASM's held object does, when `orNothing`.
   */
  protected async act(
    method: string,
    params: Record<string, unknown>,
    orNothing = false,
  ): Promise<unknown> {
    try {
      return await this.registry.call(method, { ...this.flow(), ...params });
    } catch (error) {
      if (
        orNothing &&
        this.final &&
        error instanceof NativeCryptoError &&
        error.code === 'UnknownVerification'
      ) {
        return null;
      }
      throw error;
    }
  }

  public free(): void {
    return undefined;
  }
}

/** A SAS or QR stand-in: refused once another verification replaced it on its flow. */
abstract class FlowVerification<
  T extends SasSnapshot | QrSnapshot,
> extends Mirror<T> {
  protected current(member: string): void {
    if (!this.registry.isCurrent(this)) throw stale(member);
  }

  public get otherUserId(): UserId {
    return new UserId(this.json.otherUserId);
  }

  public isDone(): boolean {
    return this.json.isDone;
  }

  public isCancelled(): boolean {
    return this.json.isCancelled;
  }

  public cancelInfo(): CancelInfo | undefined {
    return toCancelInfo(this.json.cancelInfo);
  }
}

/**
 * WASM `Sas`. `confirm` sends the decimals this object last handed out through `emoji()` or
 * `decimals()` (the SAS the user saw), or the flow's when matrix-js-sdk read another object of
 * it, never the ones a later event put in the mirror: a SAS replaced since fails `StaleObject`.
 */
export class NativeSas extends FlowVerification<SasSnapshot> {
  /** The decimals of the SAS this object showed. */
  #shown: readonly number[] | undefined;

  public readonly kind = 'sas';

  #handOut(): void {
    if (!this.json.decimals) return;
    this.#shown = this.json.decimals;
    this.registry.shown(this.key, this.json.decimals);
  }

  public emoji(): Emoji[] | undefined {
    const emoji = this.json.emoji;
    if (!emoji) return undefined;
    this.#handOut();
    return emoji.map(({ symbol, description }) =>
      wasmValue(Emoji, { symbol, description }),
    );
  }

  public decimals(): Uint16Array | undefined {
    const decimals = this.json.decimals;
    if (!decimals) return undefined;
    this.#handOut();
    return Uint16Array.from(decimals);
  }

  public async accept(): Promise<OutgoingRequest | undefined> {
    this.current('Sas.accept');
    return outgoing('acceptSas', await this.act('acceptSas', {}));
  }

  public async confirm(): Promise<OutgoingRequest[]> {
    this.current('Sas.confirm');
    const decimals = this.#shown ?? this.registry.shownFor(this.key);
    if (!decimals) {
      // The crate requires them: nothing was shown, so nothing can be confirmed.
      throw new NativeCryptoError(
        'confirmSas',
        'InvalidRequest',
        'no decimals of this SAS were shown',
      );
    }
    let confirmed: unknown;
    try {
      confirmed = await this.act('confirmSas', { decimals: [...decimals] });
    } catch (error) {
      if (!(error instanceof NativeCryptoError) || error.code !== 'StaleObject')
        throw error;
      // The user confirmed a SAS the flow no longer shows: the flow ends as a mismatch, and the
      // cancellation goes back to be sent, as upstream's confirm answers a failed check.
      const cancel = outgoing(
        'cancelSas',
        await this.act('cancelSas', { code: 'm.mismatched_sas' }),
      );
      return cancel ? [cancel] : [];
    }
    const answer = checked<RequestJson[]>(
      'confirmSas',
      confirmed,
      (value) =>
        Array.isArray(value) &&
        value.every(
          (request) =>
            isObject(request) &&
            typeof request['type'] === 'number' &&
            typeof request['body'] === 'string',
        ),
    );
    return answer.map(toRequest);
  }

  public async cancel(): Promise<OutgoingRequest | undefined> {
    this.current('Sas.cancel');
    return outgoing('cancelSas', await this.act('cancelSas', {}, true));
  }

  public async cancelWithCode(
    code: string,
  ): Promise<OutgoingRequest | undefined> {
    this.current('Sas.cancelWithCode');
    return outgoing('cancelSas', await this.act('cancelSas', { code }, true));
  }
}
standIn(NativeSas, Sas);

/** WASM `Qr`. The code's bytes hold the flow's secret: read only when asked (`toBytes`). */
export class NativeQr extends FlowVerification<QrSnapshot> {
  public readonly kind = 'qr';

  public hasBeenScanned(): boolean {
    return this.json.hasBeenScanned;
  }

  public state(): QrState {
    return this.json.state;
  }

  public async toBytes(): Promise<Uint8ClampedArray> {
    this.current('Qr.toBytes');
    const bytes = checked<string>(
      'qrCodeBytes',
      await this.act('qrCodeBytes', {}),
      (value) => typeof value === 'string',
    );
    return new Uint8ClampedArray(base64ToBytes(bytes));
  }

  public async confirmScanning(): Promise<OutgoingRequest | undefined> {
    this.current('Qr.confirmScanning');
    return outgoing(
      'confirmQrScanning',
      await this.act('confirmQrScanning', {}),
    );
  }

  public async reciprocate(): Promise<OutgoingRequest | undefined> {
    this.current('Qr.reciprocate');
    return outgoing('reciprocateQr', await this.act('reciprocateQr', {}));
  }

  public async cancel(): Promise<OutgoingRequest | undefined> {
    this.current('Qr.cancel');
    return outgoing('cancelQr', await this.act('cancelQr', {}, true));
  }
}
standIn(NativeQr, Qr);

/** WASM `VerificationRequest`. Its calls that WASM makes synchronously return promises here. */
export class NativeVerificationRequest extends Mirror<RequestSnapshot> {
  public get flowId(): string {
    return this.json.flowId;
  }

  public get roomId(): RoomId | undefined {
    return this.json.roomId === undefined
      ? undefined
      : new RoomId(this.json.roomId);
  }

  public get otherUserId(): UserId {
    return new UserId(this.json.otherUserId);
  }

  public isWith(otherUserId: string): boolean {
    return this.json.otherUserId === otherUserId;
  }

  public get otherDeviceId(): DeviceId | undefined {
    return this.json.otherDeviceId === undefined
      ? undefined
      : new DeviceId(this.json.otherDeviceId);
  }

  public get theirSupportedMethods(): VerificationMethod[] | undefined {
    return (
      this.json.theirSupportedMethods && [...this.json.theirSupportedMethods]
    );
  }

  public get cancelInfo(): CancelInfo | undefined {
    return toCancelInfo(this.json.cancelInfo);
  }

  public phase(): VerificationRequestPhase {
    return this.json.phase;
  }

  public isPassive(): boolean {
    return this.json.isPassive;
  }

  public isSelfVerification(): boolean {
    return this.json.isSelfVerification;
  }

  public weStarted(): boolean {
    return this.json.weStarted;
  }

  public isCancelled(): boolean {
    return this.json.isCancelled;
  }

  /** From the deadline the snapshot carries, as upstream counts it (a wall-clock jump moves it). */
  public timeRemainingMillis(): number {
    return Math.max(0, this.json.expiresAtMs - Date.now());
  }

  /** True at the snapshot's time, or once its deadline has passed since. */
  public timedOut(): boolean {
    return this.json.timedOut || Date.now() >= this.json.expiresAtMs;
  }

  /** The flow's SAS or QR code while the request is Transitioned, as WASM answers it. */
  public getVerification(): NativeSas | NativeQr | undefined {
    return this.json.phase === TRANSITIONED
      ? this.registry.verificationOf(this.key)
      : undefined;
  }

  public async acceptWithMethods(
    methods: VerificationMethod[],
  ): Promise<OutgoingRequest | undefined> {
    return outgoing(
      'acceptVerificationRequest',
      await this.act('acceptVerificationRequest', { methods }, true),
    );
  }

  public async cancel(): Promise<OutgoingRequest | undefined> {
    return outgoing(
      'cancelVerificationRequest',
      await this.act('cancelVerificationRequest', {}, true),
    );
  }

  public async startSas(): Promise<[Sas, OutgoingRequest] | undefined> {
    const answer = checked<[SasSnapshot, RequestJson] | null>(
      'startSas',
      await this.act('startSas', {}),
      (value) =>
        value === null ||
        (Array.isArray(value) &&
          value.length === 2 &&
          isSasSnapshot(value[0]) &&
          isOutgoing(value[1]) &&
          value[1] !== null),
    );
    if (!answer) return undefined;
    return [
      this.registry.verification(answer[0]) as unknown as Sas,
      toRequest(answer[1]),
    ];
  }

  public async generateQrCode(): Promise<Qr | undefined> {
    return this.#qr('generateQrCode', await this.act('generateQrCode', {}));
  }

  /**
   * `QrCodeScan` keeps its bytes in wasm memory with no way to read them back, so matrix-js-sdk
   * (through the repository's patch) passes the scanned bytes as well; WASM ignores them.
   */
  public async scanQrCode(
    _scan: unknown,
    bytes?: Uint8ClampedArray | Uint8Array,
  ): Promise<Qr | undefined> {
    if (!bytes) {
      throw new NativeCryptoError(
        'scanQrCode',
        'InvalidRequest',
        'the scanned bytes are needed beside the QrCodeScan',
      );
    }
    return this.#qr(
      'scanQrCode',
      await this.act('scanQrCode', {
        data: bytesToBase64(bytes),
      }),
    );
  }

  #qr(method: string, answer: unknown): Qr | undefined {
    const json = checked<QrSnapshot | null>(
      method,
      answer,
      (value) => value === null || isQrSnapshot(value),
    );
    return json
      ? (this.registry.verification(json) as unknown as Qr)
      : undefined;
  }
}
standIn(NativeVerificationRequest, VerificationRequest);

/** The machine's verification mirrors, by flow (see the header). */
export class Verifications {
  readonly #call: MachineCall;
  readonly #logger: NativeCryptoLogger | undefined;
  readonly #requests = new Map<string, NativeVerificationRequest>();
  readonly #verifications = new Map<string, NativeSas | NativeQr>();
  /** The decimals last handed out on each flow. */
  readonly #shown = new Map<string, readonly number[]>();

  public constructor(call: MachineCall, logger?: NativeCryptoLogger) {
    this.#call = call;
    this.#logger = logger;
  }

  public call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return this.#call(method, params);
  }

  public warn(message: string): void {
    this.#logger?.warn(`native crypto: ${message}`);
  }

  /** A request from an answer: the registry's object for its flow, with this snapshot. */
  public request(
    answer: unknown,
    method = 'getVerificationRequest',
  ): VerificationRequest {
    return this.#applyRequest(
      checked<RequestSnapshot>(method, answer, isRequestSnapshot),
      'answer',
    ).request as unknown as VerificationRequest;
  }

  /** A SAS or QR code from an answer. */
  public verification(json: SasSnapshot | QrSnapshot): NativeSas | NativeQr {
    return this.#place(json, false).mirror;
  }

  /** `verificationRequestChanged`: updates the mirrors; the returned mirror's callbacks are due. */
  public requestChanged(json: RequestSnapshot): Mirror<Snapshot>[] {
    return this.#applyRequest(json, 'event').due;
  }

  /**
   * `verificationChanged`: the flow's current SAS or QR code (a new one if the kind changed).
   * A flow the registry no longer holds is ignored: its request ended, and the crate sends a
   * verification's last change before its request's end, so no held object misses one.
   */
  public verificationChanged(
    json: SasSnapshot | QrSnapshot,
  ): Mirror<Snapshot>[] {
    if (!this.#requests.has(keyOf(json.otherUserId, json.flowId))) return [];
    return [this.#place(json, false).mirror];
  }

  public get(
    otherUserId: string,
    flowId: string,
  ): VerificationRequest | undefined {
    return this.#requests.get(keyOf(otherUserId, flowId)) as unknown as
      VerificationRequest | undefined;
  }

  /** The user's requests, by flow ID as the crate sorts them. */
  public forUser(otherUserId: string): VerificationRequest[] {
    return [...this.#requests.values()]
      .filter((request) => request.isWith(otherUserId))
      .sort((a, b) =>
        a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0,
      ) as unknown as VerificationRequest[];
  }

  public verificationOf(key: string): NativeSas | NativeQr | undefined {
    return this.#verifications.get(key);
  }

  public isCurrent(verification: { readonly key: string }): boolean {
    const current = this.#verifications.get(verification.key);
    return current === undefined || current === verification;
  }

  public shown(key: string, decimals: readonly number[]): void {
    this.#shown.set(key, decimals);
  }

  public shownFor(key: string): readonly number[] | undefined {
    return this.#shown.get(key);
  }

  /** Flows over before a sync input: upstream collects them during it. */
  public collectable(): string[] {
    return [...this.#requests.entries()]
      .filter(([, request]) => request.final)
      .map(([key]) => key);
  }

  public drop(keys: readonly string[]): void {
    for (const key of keys) {
      if (this.#requests.get(key)?.final) this.#forget(key);
    }
  }

  public clear(): void {
    this.#requests.clear();
    this.#verifications.clear();
    this.#shown.clear();
  }

  /**
   * After events were lost: every mirror reads its object again, and one that changed runs its
   * callbacks, as the lost event would have. A flow the crate no longer knows leaves the registry.
   */
  public async refresh(): Promise<void> {
    for (const [key, request] of [...this.#requests.entries()]) {
      const params = {
        userId: request.otherUserId.toString(),
        flowId: request.flowId,
      };
      try {
        const answer = await this.#call('getVerificationRequest', params);
        if (answer === null) {
          this.#forget(key);
          continue;
        }
        const json = checked<RequestSnapshot>(
          'getVerificationRequest',
          answer,
          isRequestSnapshot,
        );
        for (const mirror of this.#applyRequest(json, 'refresh').due)
          mirror.notify();
        // An ended request carries no verification: its SAS or QR code is read on its own.
        const verification = this.#verifications.get(key);
        if (!json.verification && verification && !verification.final) {
          const fresh = await this.#call('getVerification', params);
          if (isVerificationSnapshot(fresh)) {
            const placed = this.#place(
              fresh as SasSnapshot | QrSnapshot,
              false,
            );
            if (placed.changed) placed.mirror.notify();
          }
        }
      } catch (error) {
        this.warn(
          `a verification could not be read again: ${describeError(error)}`,
        );
      }
    }
  }

  #forget(key: string): void {
    this.#requests.delete(key);
    this.#verifications.delete(key);
    this.#shown.delete(key);
  }

  /**
   * Puts a request snapshot (and the verification it holds) on its flow. `due`: the mirrors
   * whose callbacks the change calls for, in order: an event runs the request's (each verification
   * change has an event of its own); a refresh runs those whose state it found changed.
   */
  #applyRequest(
    json: RequestSnapshot,
    from: 'answer' | 'event' | 'refresh',
  ): { request: NativeVerificationRequest; due: Mirror<Snapshot>[] } {
    const key = keyOf(json.otherUserId, json.flowId);
    const known = this.#requests.get(key);
    // A change event while the mirror is Transitioned already replaced the flow's verification.
    // A refresh is no change event: it reads the same objects again.
    const replaced = from === 'event' && known?.phase() === TRANSITIONED;
    const due: Mirror<Snapshot>[] = [];
    if (json.verification) {
      const placed = this.#place(json.verification, replaced);
      if (from === 'refresh' && placed.changed) due.push(placed.mirror);
    }
    if (!known) {
      const created = new NativeVerificationRequest(json, this);
      this.#requests.set(key, created);
      return { request: created, due };
    }
    const changed =
      from === 'event' || (from === 'refresh' && !known.same(json));
    known.update(json);
    if (changed) due.push(known);
    return { request: known, due };
  }

  /**
   * Puts a SAS or QR snapshot on its flow: a new stand-in when the flow had none, another kind,
   * or was `replaced`; otherwise the current one takes it. `changed`: the current one's state
   * differs now.
   */
  #place(
    json: SasSnapshot | QrSnapshot,
    replaced: boolean,
  ): { mirror: NativeSas | NativeQr; changed: boolean } {
    const key = keyOf(json.otherUserId, json.flowId);
    const current = this.#verifications.get(key);
    if (current && current.kind === json.kind && !replaced) {
      const mirror = current as Mirror<SasSnapshot | QrSnapshot>;
      const changed = !mirror.same(json);
      mirror.update(json);
      return { mirror: current, changed };
    }
    const created =
      json.kind === 'sas'
        ? new NativeSas(json, this)
        : new NativeQr(json as QrSnapshot, this);
    this.#verifications.set(key, created);
    return { mirror: created, changed: false };
  }
}
