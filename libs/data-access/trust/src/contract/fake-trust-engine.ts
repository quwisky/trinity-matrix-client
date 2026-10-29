import {
  BehaviorSubject,
  Observable,
  concat,
  defer,
  distinctUntilChanged,
  filter,
  map,
  merge,
  NEVER,
  of,
  startWith,
  Subject,
  take,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  OwnIdentityCheck,
  TrustEngine,
  TrustFacts,
  VerificationSnapshot,
} from '../lib/trust-engine';

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

const CRYPTO_NOT_READY: EngineFailure = {
  kind: 'unexpected',
  code: 'crypto-not-ready',
  diagnostic: { kind: 'unexpected' },
};

const REQUEST_FAILED: EngineFailure = {
  kind: 'unexpected',
  code: 'request-failed',
  diagnostic: { kind: 'unexpected' },
};

const VERIFICATION_GONE: EngineFailure = {
  kind: 'unexpected',
  code: 'verification-gone',
  diagnostic: { kind: 'unexpected' },
};

const EMOJI = [
  ['🐶', 'Dog'],
  ['🐱', 'Cat'],
  ['🦁', 'Lion'],
  ['🐎', 'Horse'],
  ['🦄', 'Unicorn'],
  ['🐷', 'Pig'],
  ['🐘', 'Elephant'],
].map(([glyph, name]) => ({ glyph, name }));

const ok = engineOk(null);

const NOTHING_READY: TrustFacts = {
  crossSigningReady: false,
  secretStorageReady: false,
  keyBackupActive: false,
  hasDefaultKey: false,
  thisDeviceCrossSigned: false,
  crossSigning: {
    publicKeysOnDevice: false,
    privateKeysInSecretStorage: false,
    privateKeysCachedLocally: {
      masterKey: false,
      selfSigningKey: false,
      userSigningKey: false,
    },
  },
};

interface FakeAccount {
  readonly facts: BehaviorSubject<EngineResult<TrustFacts>>;
  /** Failed reads, seen only by the subscriptions open when they happen. */
  readonly failures: Subject<EngineResult<TrustFacts>>;
  publishedMasterKey: string | null;
  localMasterKey: string | null;
  serverDefaultKeyId: string | null;
  readonly verification: BehaviorSubject<VerificationSnapshot | null>;
  /** Watching for incoming requests, as the js adapter does while subscribed. */
  listening: number;
}

const terminal = (snapshot: VerificationSnapshot | null) =>
  snapshot?.phase === 'done' || snapshot?.phase === 'cancelled';

/** An in-memory {@link TrustEngine}: one device per account, no homeserver. */
export class FakeTrustEngine implements TrustEngine {
  private readonly accounts = new Map<string, FakeAccount>();
  /** Users whose identity this device knows, for DM verification requests. */
  private readonly identities = new Set<string>();
  private readonly changes = new Subject<void>();
  private keys = 0;
  private flows = 0;
  /** The QR payload `showQr` returns; empty means none. */
  qrPayload = 'AP8HgA==';
  /** Every DM verification request sent, as `userId roomId`. */
  readonly sentDirectRequests: string[] = [];

  readonly alice = '@alice:contract.invalid';

  constructor() {
    this.addAccount(this.alice);
  }

  /** A live account with crypto (or without, when `crypto` is false) and no identity. */
  addAccount(accountId: string, { crypto = true } = {}): void {
    this.accounts.set(accountId, {
      facts: new BehaviorSubject<EngineResult<TrustFacts>>(
        crypto ? engineOk(NOTHING_READY) : engineFail(CRYPTO_NOT_READY),
      ),
      failures: new Subject<EngineResult<TrustFacts>>(),
      publishedMasterKey: null,
      localMasterKey: null,
      serverDefaultKeyId: null,
      verification: new BehaviorSubject<VerificationSnapshot | null>(null),
      listening: 0,
    });
  }

  /** The account signs out: its reads fail and pending waits end. */
  removeAccount(accountId: string): void {
    this.accounts.delete(accountId);
    this.changes.next();
  }

  /** This device learns `userId`'s identity, as the crypto store would after a key query. */
  addUserIdentity(userId: string): void {
    this.identities.add(userId);
    this.changes.next();
  }

  /** Another device asks this one to verify; ignored unless subscribed and none is live. */
  receiveVerification(
    accountId: string,
    request: Partial<VerificationSnapshot> = {},
  ): string {
    const account = this.require(accountId);
    const flowId = `flow-${++this.flows}`;
    if (account.listening && !this.live(account)) {
      account.verification.next({
        flowId,
        phase: 'requested',
        otherUserId: accountId,
        otherDeviceId: 'OTHER',
        isSelfVerification: true,
        initiatedByMe: false,
        theirMethods: [],
        sas: null,
        qrScannedByOther: false,
        cancellation: null,
        ...request,
      });
    }
    return flowId;
  }

  /** The current verification moves on, as the other device or the protocol would make it. */
  updateVerification(
    accountId: string,
    change: Partial<VerificationSnapshot>,
  ): void {
    const verification = this.require(accountId).verification;
    const current = verification.value;
    if (!current) throw new Error('No fake verification');
    verification.next({ ...current, ...change });
  }

  /** The SAS keys are exchanged: the emoji are shown. */
  showSas(accountId: string): void {
    this.updateVerification(accountId, { sas: { emoji: EMOJI } });
  }

  /** Replaces some facts, as a crypto change would. */
  setFacts(accountId: string, facts: Partial<TrustFacts>): void {
    const account = this.require(accountId);
    const current = account.facts.value;
    account.facts.next(
      engineOk({ ...(current.ok ? current.value : NOTHING_READY), ...facts }),
    );
  }

  /** Whether anything subscribes to the account's facts. */
  watched(accountId: string): boolean {
    return this.require(accountId).facts.observed;
  }

  /** One read fails, as a crypto store error would; a fresh subscription reads again. */
  failRead(accountId: string): void {
    this.require(accountId).failures.next(engineFail(REQUEST_FAILED));
  }

  /** This device creates, publishes and holds an identity. */
  publishIdentity(accountId: string): void {
    const account = this.require(accountId);
    const key = `master-key-${++this.keys}`;
    account.publishedMasterKey = key;
    account.localMasterKey = key;
    this.setFacts(accountId, {
      crossSigningReady: true,
      thisDeviceCrossSigned: true,
      crossSigning: {
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: false,
        privateKeysCachedLocally: {
          masterKey: true,
          selfSigningKey: true,
          userSigningKey: true,
        },
      },
    });
  }

  /** Another client points the server's secret storage at `keyId`; this device then learns it. */
  setServerDefaultKey(accountId: string, keyId: string): void {
    this.require(accountId).serverDefaultKeyId = keyId;
    this.setFacts(accountId, { hasDefaultKey: true });
  }

  facts(accountId: string): Observable<EngineResult<TrustFacts>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return concat(of(engineFail(NOT_LIVE)), NEVER);
      return merge(account.facts, account.failures).pipe(
        distinctUntilChanged<EngineResult<TrustFacts>>(plainEqual),
      );
    });
  }

  ownIdentityCheck(
    accountId: string,
  ): Observable<EngineResult<OwnIdentityCheck>> {
    return this.read(accountId, (account, facts) => ({
      // shortcut: follows publicKeysOnDevice; an identity published by another device
      // is not modelled yet, and 6.2 must add it.
      identityKnown: facts.crossSigning.publicKeysOnDevice,
      publishedMasterKey: account.publishedMasterKey,
      localMasterKey: account.localMasterKey,
      facts,
    }));
  }

  publishedMasterKey(
    accountId: string,
  ): Observable<EngineResult<string | null>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      return of(
        account ? engineOk(account.publishedMasterKey) : engineFail(NOT_LIVE),
      );
    });
  }

  serverDefaultKeyId(
    accountId: string,
  ): Observable<EngineResult<string | null>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      return of(
        account ? engineOk(account.serverDefaultKeyId) : engineFail(NOT_LIVE),
      );
    });
  }

  verification(accountId: string): Observable<VerificationSnapshot | null> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return concat(of(null), NEVER);
      // As js: unwatched, the request is forgotten, and only a to-device one still in
      // progress (a self-verification) is taken up again.
      const current = account.verification.value;
      if (
        !account.listening &&
        current &&
        (terminal(current) || !current.isSelfVerification)
      ) {
        account.verification.next(null);
      }
      account.listening++;
      return new Observable<VerificationSnapshot | null>((subscriber) => {
        const subscription = account.verification
          .pipe(distinctUntilChanged<VerificationSnapshot | null>(plainEqual))
          .subscribe(subscriber);
        return () => {
          account.listening--;
          subscription.unsubscribe();
        };
      });
    });
  }

  requestOwnVerification(
    accountId: string,
  ): Observable<EngineResult<{ readonly flowId: string }>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return of(engineFail(NOT_LIVE));
      if (!account.publishedMasterKey) return of(engineFail(REQUEST_FAILED));
      return of(engineOk({ flowId: this.send(account, accountId, true) }));
    });
  }

  requestUserVerification(
    accountId: string,
    userId: string,
    roomId: string,
  ): Observable<EngineResult<{ readonly flowId: string }>> {
    return this.changes.pipe(
      startWith(undefined),
      map(() => this.accounts.get(accountId)),
      filter((account) => !account || this.identities.has(userId)),
      take(1),
      map((account) => {
        if (!account) return engineFail(NOT_LIVE);
        this.sentDirectRequests.push(`${userId} ${roomId}`);
        return engineOk({ flowId: this.send(account, userId, false) });
      }),
    );
  }

  acceptVerification(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>> {
    return this.step(accountId, flowId, (current) => ({
      ...current,
      phase: 'ready',
      theirMethods: [
        'm.sas.v1',
        'm.qr_code.show.v1',
        'm.qr_code.scan.v1',
        'm.reciprocate.v1',
      ],
    }));
  }

  startSas(accountId: string, flowId: string): Observable<EngineResult<null>> {
    return this.step(accountId, flowId, (current) => ({
      ...current,
      phase: 'started',
    }));
  }

  confirmSas(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>> {
    return this.step(accountId, flowId, (current) =>
      current.sas ? current : null,
    );
  }

  mismatchSas(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>> {
    return this.step(accountId, flowId, (current) => ({
      ...current,
      phase: 'cancelled',
      cancellation: { code: 'm.mismatched_sas' },
    }));
  }

  showQr(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<{ readonly qr: string }>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return of(engineFail(NOT_LIVE));
      if (account.verification.value?.flowId !== flowId) {
        return of(engineFail(VERIFICATION_GONE));
      }
      if (!this.qrPayload) {
        return of(
          engineFail({
            kind: 'unexpected',
            code: 'qr-unavailable',
            diagnostic: { kind: 'unexpected' },
          }),
        );
      }
      return of(engineOk({ qr: this.qrPayload }));
    });
  }

  scanQr(
    accountId: string,
    flowId: string,
    qr: string,
  ): Observable<EngineResult<null>> {
    void qr;
    return this.step(accountId, flowId, (current) => ({
      ...current,
      phase: 'started',
    }));
  }

  confirmQr(accountId: string, flowId: string): Observable<EngineResult<null>> {
    return this.step(accountId, flowId, (current) =>
      current.qrScannedByOther ? { ...current, qrScannedByOther: false } : null,
    );
  }

  cancelVerification(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>> {
    return this.step(accountId, flowId, (current) =>
      terminal(current)
        ? current
        : { ...current, phase: 'cancelled', cancellation: { code: 'm.user' } },
    );
  }

  private live(account: FakeAccount): boolean {
    const current = account.verification.value;
    return current !== null && !terminal(current);
  }

  private send(
    account: FakeAccount,
    otherUserId: string,
    isSelfVerification: boolean,
  ): string {
    const flowId = `flow-${++this.flows}`;
    account.verification.next({
      flowId,
      phase: 'requested',
      otherUserId,
      otherDeviceId: null,
      isSelfVerification,
      initiatedByMe: true,
      theirMethods: [],
      sas: null,
      qrScannedByOther: false,
      cancellation: null,
    });
    return flowId;
  }

  /** Applies `next` to the current flow; null from `next` means the step is not possible now. */
  private step(
    accountId: string,
    flowId: string,
    next: (current: VerificationSnapshot) => VerificationSnapshot | null,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return of(engineFail(NOT_LIVE));
      const current = account.verification.value;
      const updated = current?.flowId === flowId ? next(current) : null;
      if (!updated) return of(engineFail(VERIFICATION_GONE));
      account.verification.next(updated);
      return of(ok);
    });
  }

  private read<T>(
    accountId: string,
    run: (account: FakeAccount, facts: TrustFacts) => T,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return of(engineFail(NOT_LIVE));
      return of(account.facts.value).pipe(
        map((facts) =>
          facts.ok ? engineOk(run(account, facts.value)) : facts,
        ),
      );
    });
  }

  private require(accountId: string): FakeAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`No fake account ${accountId}`);
    return account;
  }
}
