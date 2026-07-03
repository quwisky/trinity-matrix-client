import { Injectable, inject, signal } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type CryptoApi,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from 'matrix-js-sdk/lib/crypto-api';
import { Observable, defer, from, of } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';

/** UI-facing stage of the active verification (maps the SDK's numeric phase). */
export type VerificationStage =
  'requested' | 'ready' | 'sas-shown' | 'waiting' | 'done' | 'cancelled';

/** One Short-Authentication-String emoji: the glyph plus its English name. */
export interface SasEmoji {
  glyph: string;
  name: string;
}

/** Plain view model of the active verification — no SDK types leak to the UI. */
export interface VerificationView {
  stage: VerificationStage;
  otherUserId: string | null;
  otherDeviceId: string | null;
  /** Verifying our own other device (vs another user). MVP only does self. */
  isSelfVerification: boolean;
  /** The other side initiated the request (we should offer accept/decline). */
  incoming: boolean;
  /** The seven SAS emoji to compare — populated only in the `sas-shown` stage. */
  emoji: SasEmoji[] | null;
  cancelReason: string | null;
}

const SAS_METHOD = 'm.sas.v1';

/**
 * Drives interactive device verification (emoji SAS). Wraps the SDK's
 * `VerificationRequest`/`Verifier` so the UI never touches matrix-js-sdk: a single
 * `active` signal exposes the current verification as a {@link VerificationView},
 * and cold Observables perform the actions. Mirrors {@link CryptoService}'s shape
 * (instance-keyed idempotent `connect()`/`disconnect()`).
 *
 * MVP scope: self-verification (verify your own other devices) over SAS. QR and
 * cross-user verification are deliberately out of scope (Milestone 7 plan).
 */
@Injectable({ providedIn: 'root' })
export class VerificationService {
  private readonly matrix = inject(MatrixClientService);
  private connectedClient: MatrixClient | null = null;

  private request: VerificationRequest | null = null;
  private verifier: Verifier | null = null;
  private sas: ShowSasCallbacks | null = null;

  private readonly _active = signal<VerificationView | null>(null);
  /** The active verification, or `null` when none is in flight. */
  readonly active = this._active.asReadonly();

  private readonly onIncoming = (request: VerificationRequest): void => {
    // One verification at a time (MVP): ignore new requests while one is live.
    if (this.request && !this.isTerminal(this.request)) {
      return;
    }
    this.adopt(request);
  };

  private readonly onRequestChange = (): void => {
    const req = this.request;
    if (!req) {
      return;
    }
    // Once in flight, attach to the verifier (created by us or the other device)
    // and drive the SAS exchange.
    if (
      req.phase === VerificationPhase.Started &&
      !this.verifier &&
      req.verifier
    ) {
      this.attachVerifier(req.verifier);
    }
    this.recompute();
  };

  private readonly onShowSas = (sas: ShowSasCallbacks): void => {
    this.sas = sas;
    this.recompute();
  };

  private readonly onVerifierCancel = (): void => this.recompute();

  /**
   * Listen for incoming verification requests and adopt any already in flight.
   * Idempotent per client; re-running after a re-login rewires onto the new one.
   */
  connect(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    if (this.connectedClient === client) {
      return;
    }
    this.disconnect();
    this.connectedClient = client;
    client.on(CryptoEvent.VerificationRequestReceived, this.onIncoming);
    // Adopt a request that predates the listener (e.g. started on another device
    // during a reload).
    const inProgress = this.inProgressRequest(client);
    if (inProgress) {
      this.adopt(inProgress);
    }
  }

  /** Detach listeners and clear any active verification. */
  disconnect(): void {
    this.connectedClient?.off(
      CryptoEvent.VerificationRequestReceived,
      this.onIncoming,
    );
    this.clearRequest();
    this.connectedClient = null;
    this._active.set(null);
  }

  /** Send a verification request to our other devices (emoji SAS). */
  startSelfVerification(): Observable<void> {
    return defer(() =>
      from(
        (async (): Promise<void> => {
          const request =
            await this.requireCrypto().requestOwnUserVerification();
          this.adopt(request);
        })(),
      ),
    );
  }

  /** Accept an incoming verification request. */
  accept(): Observable<void> {
    return defer(() => from(this.requireRequest().accept()));
  }

  /** Begin the emoji-SAS method once the request is `ready`. */
  startSas(): Observable<void> {
    return defer(() =>
      from(
        (async (): Promise<void> => {
          const verifier =
            await this.requireRequest().startVerification(SAS_METHOD);
          this.attachVerifier(verifier);
        })(),
      ),
    );
  }

  /** Confirm the SAS emoji match (completes the verification). */
  confirmSas(): Observable<void> {
    return defer(() => {
      const sas = this.sas;
      if (!sas) {
        throw new Error('There is nothing to confirm yet.');
      }
      return from(sas.confirm());
    });
  }

  /** Report that the SAS emoji do NOT match (aborts as a security failure). */
  mismatchSas(): Observable<void> {
    return defer(() => {
      this.sas?.mismatch();
      return of(void 0);
    });
  }

  /** Cancel or decline the active verification. */
  cancel(): Observable<void> {
    return defer(() =>
      from(
        (async (): Promise<void> => {
          this.verifier?.cancel(new Error('Verification cancelled.'));
          const req = this.request;
          if (req && !this.isTerminal(req)) {
            await req.cancel();
          }
        })(),
      ),
    );
  }

  /** Clear a finished/cancelled verification so its UI can close. */
  dismiss(): void {
    this.clearRequest();
    this._active.set(null);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private adopt(request: VerificationRequest): void {
    this.clearRequest();
    this.request = request;
    request.on(VerificationRequestEvent.Change, this.onRequestChange);
    if (request.phase === VerificationPhase.Started && request.verifier) {
      this.attachVerifier(request.verifier);
    }
    this.recompute();
  }

  private attachVerifier(verifier: Verifier): void {
    if (this.verifier) {
      return;
    }
    this.verifier = verifier;
    verifier.on(VerifierEvent.ShowSas, this.onShowSas);
    verifier.on(VerifierEvent.Cancel, this.onVerifierCancel);
    // Drives the exchange and emits ShowSas; the result surfaces via the phase /
    // cancel events, so the rejection here is intentionally swallowed.
    verifier.verify().catch(() => undefined);
  }

  private clearRequest(): void {
    this.request?.off(VerificationRequestEvent.Change, this.onRequestChange);
    this.verifier?.off(VerifierEvent.ShowSas, this.onShowSas);
    this.verifier?.off(VerifierEvent.Cancel, this.onVerifierCancel);
    this.request = null;
    this.verifier = null;
    this.sas = null;
  }

  private recompute(): void {
    const req = this.request;
    if (!req) {
      this._active.set(null);
      return;
    }
    this._active.set({
      stage: this.stageOf(req),
      otherUserId: req.otherUserId ?? null,
      otherDeviceId: req.otherDeviceId ?? null,
      isSelfVerification: req.isSelfVerification,
      incoming: !req.initiatedByMe,
      emoji:
        this.sas?.sas.emoji?.map(([glyph, name]) => ({ glyph, name })) ?? null,
      cancelReason:
        req.phase === VerificationPhase.Cancelled
          ? this.cancelReason(req)
          : null,
    });
  }

  private stageOf(req: VerificationRequest): VerificationStage {
    switch (req.phase) {
      case VerificationPhase.Unsent:
      case VerificationPhase.Requested:
        return 'requested';
      case VerificationPhase.Ready:
        return 'ready';
      case VerificationPhase.Started:
        return this.sas ? 'sas-shown' : 'waiting';
      case VerificationPhase.Done:
        return 'done';
      case VerificationPhase.Cancelled:
        return 'cancelled';
      default:
        return 'requested';
    }
  }

  private cancelReason(req: VerificationRequest): string {
    switch (req.cancellationCode) {
      case 'm.mismatched_sas':
        return 'The emoji did not match — verification was stopped.';
      case 'm.timeout':
        return 'The verification timed out.';
      default:
        return 'The verification was cancelled.';
    }
  }

  private isTerminal(req: VerificationRequest): boolean {
    return (
      req.phase === VerificationPhase.Done ||
      req.phase === VerificationPhase.Cancelled
    );
  }

  private inProgressRequest(client: MatrixClient): VerificationRequest | null {
    const crypto = client.getCrypto();
    const userId = client.getUserId();
    if (!crypto || !userId) {
      return null;
    }
    return crypto.getVerificationRequestsToDeviceInProgress(userId)[0] ?? null;
  }

  private requireCrypto(): CryptoApi {
    const crypto = this.matrix.instance.getCrypto();
    if (!crypto) {
      throw new Error('Crypto is not initialized on the client.');
    }
    return crypto;
  }

  private requireRequest(): VerificationRequest {
    if (!this.request) {
      throw new Error('No verification in progress.');
    }
    return this.request;
  }
}
