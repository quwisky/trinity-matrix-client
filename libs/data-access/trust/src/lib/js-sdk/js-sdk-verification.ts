import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowQrCodeCallbacks,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from 'matrix-js-sdk/lib/crypto-api';
import { BehaviorSubject, type Observable, distinctUntilChanged } from 'rxjs';
import { plainEqual } from '@trinity/util/matrix';
import type {
  VerificationMethod,
  VerificationSnapshot,
  VerificationPhase as Phase,
} from '../trust-engine';

const METHODS: readonly VerificationMethod[] = [
  'm.sas.v1',
  'm.qr_code.show.v1',
  'm.qr_code.scan.v1',
  'm.reciprocate.v1',
];

export function flowIdOf(request: VerificationRequest): string {
  return request.transactionId ?? '';
}

export function isTerminal(request: VerificationRequest): boolean {
  return (
    request.phase === VerificationPhase.Done ||
    request.phase === VerificationPhase.Cancelled
  );
}

function phaseOf(request: VerificationRequest): Phase {
  switch (request.phase) {
    case VerificationPhase.Ready:
      return 'ready';
    case VerificationPhase.Started:
      return 'started';
    case VerificationPhase.Done:
      return 'done';
    case VerificationPhase.Cancelled:
      return 'cancelled';
    default:
      return 'requested';
  }
}

/**
 * One client's current verification: the SDK request, its verifier and the method
 * callbacks, published as a {@link VerificationSnapshot}. One at a time, as Trinity's UI.
 */
export class ClientVerification {
  private verifier: Verifier | null = null;
  private sasCallbacks: ShowSasCallbacks | null = null;
  private qrCallbacks: ShowQrCodeCallbacks | null = null;
  private watchers = 0;
  private readonly current = new BehaviorSubject<VerificationSnapshot | null>(
    null,
  );

  private readonly onChange = (): void => {
    const request = this.request;
    if (
      request?.phase === VerificationPhase.Started &&
      !this.verifier &&
      request.verifier
    ) {
      this.attach(request.verifier);
    }
    this.publish();
  };

  private readonly onShowSas = (sas: ShowSasCallbacks): void => {
    this.sasCallbacks = sas;
    this.publish();
  };

  private readonly onShowQr = (qr: ShowQrCodeCallbacks): void => {
    this.qrCallbacks = qr;
    this.publish();
  };

  private readonly onCancel = (): void => this.publish();

  request: VerificationRequest | null = null;

  readonly snapshot: Observable<VerificationSnapshot | null> =
    this.current.pipe(
      distinctUntilChanged<VerificationSnapshot | null>(plainEqual),
    );

  watch(): void {
    this.watchers++;
  }

  /**
   * The last watcher leaving forgets the request without cancelling it, as the service did
   * on reset; a later watch takes up only a to-device request still in progress.
   */
  unwatch(): void {
    if (--this.watchers > 0) return;
    this.release();
    this.publish();
  }

  /** Takes up `request` unless one is still live. */
  offer(request: VerificationRequest): void {
    if (this.request && !isTerminal(this.request)) return;
    this.adopt(request);
  }

  adopt(request: VerificationRequest): void {
    this.release();
    this.request = request;
    request.on(VerificationRequestEvent.Change, this.onChange);
    if (request.phase === VerificationPhase.Started && request.verifier) {
      this.attach(request.verifier);
    }
    this.publish();
  }

  /** The request behind `flowId` when it is still the current one. */
  find(flowId: string): VerificationRequest | null {
    return this.request && flowIdOf(this.request) === flowId
      ? this.request
      : null;
  }

  sas(): ShowSasCallbacks | null {
    return this.sasCallbacks;
  }

  /** Confirms the other device's scan once, then drops the callbacks. */
  confirmQr(): boolean {
    const qr = this.qrCallbacks;
    if (!qr) return false;
    qr.confirm();
    this.qrCallbacks = null;
    this.publish();
    return true;
  }

  cancelVerifier(): void {
    this.verifier?.cancel(new Error('Verification cancelled.'));
  }

  attach(verifier: Verifier): void {
    if (this.verifier) return;
    this.verifier = verifier;
    verifier.on(VerifierEvent.ShowSas, this.onShowSas);
    verifier.on(VerifierEvent.ShowReciprocateQr, this.onShowQr);
    verifier.on(VerifierEvent.Cancel, this.onCancel);
    const sas = verifier.getShowSasCallbacks();
    if (sas) this.onShowSas(sas);
    const qr = verifier.getReciprocateQrCodeCallbacks();
    if (qr) this.onShowQr(qr);
    // Drives the exchange; the outcome arrives as phase and cancel events.
    verifier.verify().catch(() => undefined);
  }

  private release(): void {
    this.request?.off(VerificationRequestEvent.Change, this.onChange);
    this.verifier?.off(VerifierEvent.ShowSas, this.onShowSas);
    this.verifier?.off(VerifierEvent.ShowReciprocateQr, this.onShowQr);
    this.verifier?.off(VerifierEvent.Cancel, this.onCancel);
    this.request = null;
    this.verifier = null;
    this.sasCallbacks = null;
    this.qrCallbacks = null;
  }

  private publish(): void {
    const request = this.request;
    this.current.next(
      request
        ? {
            flowId: flowIdOf(request),
            phase: phaseOf(request),
            otherUserId: request.otherUserId,
            otherDeviceId: request.otherDeviceId ?? null,
            isSelfVerification: request.isSelfVerification,
            initiatedByMe: request.initiatedByMe,
            theirMethods: METHODS.filter((method) =>
              request.otherPartySupportsMethod(method),
            ),
            sas: this.sasCallbacks?.sas.emoji
              ? {
                  emoji: this.sasCallbacks.sas.emoji.map(([glyph, name]) => ({
                    glyph,
                    name,
                  })),
                }
              : null,
            qrScannedByOther: this.qrCallbacks !== null,
            cancellation:
              request.phase === VerificationPhase.Cancelled
                ? { code: request.cancellationCode ?? 'm.user' }
                : null,
          }
        : null,
    );
  }
}
