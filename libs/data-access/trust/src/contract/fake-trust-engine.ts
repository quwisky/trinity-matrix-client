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
  type RecoveryRefusal,
  decryptMegolmKeyFile,
  encryptMegolmKeyFile,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  InteractiveUpdate,
  OwnDevice,
  OwnIdentityCheck,
  RecoverySecret,
  TrustEngine,
  TrustFacts,
  UserTrustFacts,
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
const failure = (code: EngineFailure['code']): EngineFailure =>
  ({
    kind: 'unexpected',
    code,
    diagnostic: { kind: 'unexpected' },
  }) as EngineFailure;

const refused = (reason: RecoveryRefusal): EngineFailure => ({
  kind: 'unexpected',
  code: 'recovery-refused',
  params: { reason },
  diagnostic: { kind: 'unexpected' },
});

/** Like the shared password-UIA budget: three rejected passwords end the command. */
const PASSWORD_ATTEMPTS = 3;

/** The base58 alphabet recovery keys are written in. */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Shaped like a recovery key: `Es`, then 46 base58 characters, spaces ignored. */
const WELL_FORMED_KEY = /^Es[1-9A-HJ-NP-Za-km-z]{46}$/;

const compact = (key: string): string => key.replace(/\s/g, '');

const UNVERIFIED: UserTrustFacts = {
  verified: false,
  wasVerified: false,
  needsApproval: false,
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
  readonly verification: BehaviorSubject<VerificationSnapshot | null>;
  /** Watching for incoming requests, as the js adapter does while subscribed. */
  listening: number;
  readonly devices: BehaviorSubject<readonly OwnDevice[]>;
  /** The device this engine runs as. */
  readonly deviceId: string;
  /** How the account sees each user it was asked about. */
  readonly users: Map<string, BehaviorSubject<UserTrustFacts>>;
  /** Users the account has seen an identity of; a later publish is a change. */
  readonly identities: Set<string>;
  /** The server asks for a non-password stage, as for an SSO-only account. */
  providerAuthOnly: boolean;
  /** The account's secret storage, set up from a key or a passphrase. */
  recovery: { readonly key: string; readonly passphrase: string | null } | null;
  /** The session ids of the room keys this device holds. */
  readonly roomKeys: Set<string>;
}

const terminal = (snapshot: VerificationSnapshot | null) =>
  snapshot?.phase === 'done' || snapshot?.phase === 'cancelled';

/** An in-memory {@link TrustEngine}: one device per account, no homeserver. */
export class FakeTrustEngine implements TrustEngine {
  private readonly accounts = new Map<string, FakeAccount>();
  /** Users whose identity this device knows, for DM verification requests. */
  private readonly identities = new Set<string>();
  private readonly changes = new Subject<void>();
  private readonly prompts = new Map<
    string,
    { readonly accountId: string; answer(password: string | null): void }
  >();
  private keys = 0;
  private flows = 0;
  /** The QR payload `showQr` returns; empty means none. */
  qrPayload = 'AP8HgA==';
  /** Every DM verification request sent, as `userId roomId`. */
  readonly sentDirectRequests: string[] = [];
  private sequence = 0;

  readonly alice = '@alice:contract.invalid';
  /** Every fake account's password. */
  readonly password = 'fake-password';

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
      deviceId: 'FAKEDEVICE',
      devices: new BehaviorSubject<readonly OwnDevice[]>([
        {
          deviceId: 'FAKEDEVICE',
          displayName: null,
          lastSeenTs: null,
          lastSeenIp: null,
          isCurrent: true,
          verified: false,
        },
      ]),
      users: new Map(),
      identities: new Set(),
      providerAuthOnly: false,
      recovery: null,
      roomKeys: new Set(),
    });
  }

  /** The device this engine runs as. */
  deviceIdOf(accountId: string): string {
    return this.require(accountId).deviceId;
  }

  /** The account signs in on another device; returns its id. */
  addDevice(accountId: string, device: Partial<OwnDevice> = {}): string {
    const account = this.require(accountId);
    const added: OwnDevice = {
      deviceId: `OTHER${++this.sequence}`,
      displayName: null,
      lastSeenTs: null,
      lastSeenIp: null,
      isCurrent: false,
      verified: false,
      ...device,
    };
    account.devices.next([...account.devices.value, added]);
    return added.deviceId;
  }

  /** The server then asks for an identity-provider stage instead of a password. */
  requireProviderAuth(accountId: string): void {
    this.require(accountId).providerAuthOnly = true;
  }

  /** Another device of the account publishes an identity; this one learns its public keys. */
  publishIdentityElsewhere(accountId: string): void {
    const account = this.require(accountId);
    account.publishedMasterKey = `master-key-${++this.keys}`;
    account.localMasterKey = null;
    this.setFacts(accountId, {
      crossSigningReady: false,
      crossSigning: {
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: false,
        privateKeysCachedLocally: {
          masterKey: false,
          selfSigningKey: false,
          userSigningKey: false,
        },
      },
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

  /**
   * `userId` publishes an identity and the account sees it. The first one is pinned on
   * sight; a later one needs approval.
   */
  publishUserIdentity(accountId: string, userId: string): void {
    const account = this.require(accountId);
    if (!account.identities.has(userId)) {
      account.identities.add(userId);
      return;
    }
    const user = this.userOf(account, userId);
    user.next({ ...user.value, verified: false, needsApproval: true });
  }

  /** Replaces how the account sees `userId`, as a verification would. */
  setUserTrust(
    accountId: string,
    userId: string,
    trust: Partial<UserTrustFacts>,
  ): void {
    const account = this.require(accountId);
    account.identities.add(userId);
    const user = this.userOf(account, userId);
    user.next({ ...user.value, ...trust });
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

  /**
   * Another device publishes an identity, secret storage and a key backup, from a random
   * recovery key or from `passphrase`; returns the recovery key.
   */
  setUpRecoveryElsewhere(accountId: string, passphrase?: string): string {
    const account = this.require(accountId);
    const digits = Array.from(
      { length: 46 },
      () => BASE58[Math.floor(Math.random() * BASE58.length)],
    ).join('');
    const key = `Es${digits}`.replace(/(.{4})(?!$)/g, '$1 ');
    account.recovery = { key, passphrase: passphrase ?? null };
    this.publishIdentityElsewhere(accountId);
    account.serverDefaultKeyId = `fake-4s-${++this.keys}`;
    this.setFacts(accountId, {
      hasDefaultKey: true,
      crossSigning: {
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: true,
        privateKeysCachedLocally: {
          masterKey: false,
          selfSigningKey: false,
          userSigningKey: false,
        },
      },
    });
    return key;
  }

  /** This device rotates its identity for a reset that never uploads it. */
  strandUnpublishedIdentity(accountId: string): void {
    const account = this.require(accountId);
    account.localMasterKey = `stranded-key-${++this.keys}`;
    const current = account.facts.value;
    this.setFacts(accountId, {
      crossSigningReady: false,
      thisDeviceCrossSigned: false,
      crossSigning: {
        publicKeysOnDevice: true,
        privateKeysInSecretStorage: current.ok
          ? current.value.crossSigning.privateKeysInSecretStorage
          : false,
        privateKeysCachedLocally: {
          masterKey: true,
          selfSigningKey: true,
          userSigningKey: true,
        },
      },
    });
  }

  /** A key file of one room key, as another session of the account exports it. */
  async exportFromAnotherSession(
    passphrase: string,
  ): Promise<{ readonly fileText: string; readonly sessionId: string }> {
    const sessionId = `fake-session-${++this.sequence}`;
    return {
      fileText: await encryptMegolmKeyFile(
        JSON.stringify([roomKey(sessionId)]),
        passphrase,
      ),
      sessionId,
    };
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
      identityKnown:
        account.publishedMasterKey !== null ||
        facts.crossSigning.publicKeysOnDevice,
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

  ownDevices(
    accountId: string,
  ): Observable<EngineResult<readonly OwnDevice[]>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return concat(of(engineFail(NOT_LIVE)), NEVER);
      return account.devices.pipe(map((devices) => engineOk(devices)));
    });
  }

  renameDevice(
    accountId: string,
    deviceId: string,
    name: string,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return of(engineFail(NOT_LIVE));
      account.devices.next(
        account.devices.value.map((device) =>
          device.deviceId === deviceId
            ? { ...device, displayName: name || null }
            : device,
        ),
      );
      return of(engineOk(null));
    });
  }

  deleteDevice(
    accountId: string,
    deviceId: string,
  ): Observable<InteractiveUpdate<null>> {
    return defer(() =>
      deviceId === this.accounts.get(accountId)?.deviceId
        ? of<InteractiveUpdate<null>>({
            kind: 'done',
            result: engineFail(failure('unsupported')),
          })
        : this.interactive(accountId, (account) => {
            account.devices.next(
              account.devices.value.filter(
                (device) => device.deviceId !== deviceId,
              ),
            );
            return engineOk(null);
          }),
    );
  }

  preAuthenticate(
    accountId: string,
  ): Observable<InteractiveUpdate<{ readonly password: string | null }>> {
    return this.interactive(accountId, (_account, password) =>
      engineOk({ password }),
    );
  }

  answerPrompt(
    accountId: string,
    promptId: string,
    password: string | null,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const prompt = this.prompts.get(promptId);
      if (prompt?.accountId !== accountId) {
        return of(engineFail(failure('prompt-gone')));
      }
      prompt.answer(password);
      return of(engineOk(null));
    });
  }

  userTrust(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<UserTrustFacts>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return concat(of(engineFail(NOT_LIVE)), NEVER);
      if (!account.facts.value.ok)
        return concat(of(account.facts.value), NEVER);
      return this.userOf(account, userId).pipe(
        map((trust) => engineOk(trust)),
        distinctUntilChanged<EngineResult<UserTrustFacts>>(plainEqual),
      );
    });
  }

  pinIdentity(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<null>> {
    return this.identityChange(accountId, userId, { needsApproval: false });
  }

  withdrawVerification(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<null>> {
    return this.identityChange(accountId, userId, { wasVerified: false });
  }

  recover(
    accountId: string,
    secret: RecoverySecret,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return of(engineFail(NOT_LIVE));
      if (!account.facts.value.ok) return of(account.facts.value);
      const recovery = account.recovery;
      if (!recovery) return of(engineFail(refused('not-configured')));
      if (secret.kind === 'recovery-key') {
        if (!WELL_FORMED_KEY.test(compact(secret.value))) {
          return of(engineFail(refused('malformed-key')));
        }
        if (compact(secret.value) !== compact(recovery.key)) {
          return of(engineFail(refused('incorrect')));
        }
      } else if (recovery.passphrase === null) {
        return of(engineFail(refused('no-passphrase')));
      } else if (secret.value !== recovery.passphrase) {
        return of(engineFail(refused('incorrect')));
      }
      account.localMasterKey = account.publishedMasterKey;
      this.setFacts(accountId, {
        crossSigningReady: true,
        secretStorageReady: true,
        keyBackupActive: true,
        thisDeviceCrossSigned: true,
        crossSigning: {
          publicKeysOnDevice: true,
          privateKeysInSecretStorage: true,
          privateKeysCachedLocally: {
            masterKey: true,
            selfSigningKey: true,
            userSigningKey: true,
          },
        },
      });
      return of(engineOk(null));
    });
  }

  exportRoomKeys(
    accountId: string,
    passphrase: string,
  ): Observable<EngineResult<string>> {
    return defer(async () => {
      const account = this.accounts.get(accountId);
      if (!account) return engineFail(NOT_LIVE);
      if (!account.facts.value.ok) return account.facts.value;
      const keys = [...account.roomKeys].map(roomKey);
      return engineOk(
        await encryptMegolmKeyFile(JSON.stringify(keys), passphrase),
      );
    });
  }

  importRoomKeys(
    accountId: string,
    fileText: string,
    passphrase: string,
  ): Observable<EngineResult<null>> {
    return defer(async () => {
      const account = this.accounts.get(accountId);
      if (!account) return engineFail(NOT_LIVE);
      if (!account.facts.value.ok) return account.facts.value;
      let keys: { session_id: string }[];
      try {
        keys = JSON.parse(await decryptMegolmKeyFile(fileText, passphrase));
      } catch {
        return engineFail(refused('incorrect'));
      }
      for (const key of keys) account.roomKeys.add(key.session_id);
      return engineOk(null);
    });
  }

  /** Whether a password prompt is open. */
  promptOpen(): boolean {
    return this.prompts.size > 0;
  }

  /** How many subscriptions follow how the account sees users. */
  userSubscriptions(accountId: string): number {
    return [...this.require(accountId).users.values()].filter(
      (user) => user.observed,
    ).length;
  }

  private identityChange(
    accountId: string,
    userId: string,
    change: Partial<UserTrustFacts>,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const account = this.accounts.get(accountId);
      if (!account) return of(engineFail(NOT_LIVE));
      if (!account.facts.value.ok) return of(account.facts.value);
      // As the SDK does for a user whose identity it has never seen.
      if (!account.identities.has(userId)) {
        return of(engineFail(failure('request-failed')));
      }
      const user = this.userOf(account, userId);
      user.next({ ...user.value, ...change });
      return of(engineOk(null));
    });
  }

  /**
   * One password stage, as the shared UIA driver runs it: a prompt per attempt, a cancel
   * on null or unsubscribe, `uia-attempts-exceeded` after three rejected passwords.
   */
  private interactive<T>(
    accountId: string,
    run: (account: FakeAccount, password: string) => EngineResult<T>,
  ): Observable<InteractiveUpdate<T>> {
    return new Observable<InteractiveUpdate<T>>((subscriber) => {
      const done = (result: EngineResult<T>): void => {
        subscriber.next({ kind: 'done', result });
        subscriber.complete();
      };
      const account = this.accounts.get(accountId);
      if (!account) {
        done(engineFail(NOT_LIVE));
        return undefined;
      }
      if (account.providerAuthOnly) {
        done(engineFail(failure('uia-unsupported')));
        return undefined;
      }
      let attempts = 0;
      let promptId: string | null = null;
      const ask = (rejected: boolean): void => {
        const id = `fake-prompt-${++this.sequence}`;
        promptId = id;
        this.prompts.set(id, {
          accountId,
          answer: (password) => {
            this.prompts.delete(id);
            promptId = null;
            if (password === null)
              return done(engineFail(failure('uia-cancelled')));
            attempts++;
            if (password === this.password) return done(run(account, password));
            if (attempts >= PASSWORD_ATTEMPTS) {
              return done(engineFail(failure('uia-attempts-exceeded')));
            }
            ask(true);
          },
        });
        subscriber.next({ kind: 'password-required', promptId: id, rejected });
      };
      ask(false);
      return () => {
        if (promptId) this.prompts.delete(promptId);
      };
    });
  }

  private userOf(
    account: FakeAccount,
    userId: string,
  ): BehaviorSubject<UserTrustFacts> {
    let user = account.users.get(userId);
    if (!user) {
      user = new BehaviorSubject(UNVERIFIED);
      account.users.set(userId, user);
    }
    return user;
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

/** One exported room key, in the key-export JSON shape. */
function roomKey(sessionId: string) {
  return {
    algorithm: 'm.megolm.v1.aes-sha2',
    room_id: '!fake:contract.invalid',
    sender_key: 'fake-sender-key',
    session_id: sessionId,
    session_key: 'fake-session-key',
    sender_claimed_keys: {},
    forwarding_curve25519_key_chain: [],
  };
}
