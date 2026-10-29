import {
  BehaviorSubject,
  type Observable,
  concat,
  defer,
  distinctUntilChanged,
  map,
  merge,
  NEVER,
  of,
  Subject,
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
}

/** An in-memory {@link TrustEngine}: one device per account, no homeserver. */
export class FakeTrustEngine implements TrustEngine {
  private readonly accounts = new Map<string, FakeAccount>();
  private keys = 0;

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
    });
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
    this.require(accountId).failures.next(
      engineFail({
        kind: 'unexpected',
        code: 'request-failed',
        diagnostic: { kind: 'unexpected' },
      }),
    );
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
