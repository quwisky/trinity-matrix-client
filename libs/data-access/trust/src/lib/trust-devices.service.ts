import { Injectable, inject, signal } from '@angular/core';
import { type Observable, combineLatest, defer, map, take } from 'rxjs';
import {
  SessionStateService,
  projectActiveAccount,
} from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  type EngineFailure,
  type EngineResult,
  type PasswordPrompt,
} from '@trinity/util/matrix';
import { answerPasswordPrompts } from './password-prompts';
import type { OwnDevice, TrustFacts } from './trust-engine';
import { TRUST_ENGINE } from './trust-engine.token';
import {
  TrustOperationError,
  recoverTrustOperation,
} from './trust-operation-error';
import { holdsCrossSigningIdentity } from './trust-snapshot';

/** A signed-in device (session) for the current user. */
export interface DeviceInfo {
  id: string;
  /** `display_name`, defaulted to the device id. */
  displayName: string;
  lastSeenTs: number | null;
  lastSeenIp: string | null;
  /** This session's own device. */
  isCurrent: boolean;
  /** Cross-signing verified (trusted). */
  isVerified: boolean;
}

const NO_ACCOUNT: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

/** Current device first, then the most recently seen. */
function toDeviceInfos(devices: readonly OwnDevice[]): DeviceInfo[] {
  return devices
    .map((device) => ({
      id: device.deviceId,
      displayName: device.displayName ?? device.deviceId,
      lastSeenTs: device.lastSeenTs,
      lastSeenIp: device.lastSeenIp,
      isCurrent: device.isCurrent,
      isVerified: device.verified,
    }))
    .sort((a, b) =>
      a.isCurrent !== b.isCurrent
        ? a.isCurrent
          ? -1
          : 1
        : (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0),
    );
}

/** This device caches all three private keys and they match the identity it trusts. */
const canShareFrom = (facts: EngineResult<TrustFacts>): boolean =>
  facts.ok &&
  holdsCrossSigningIdentity(
    facts.value.crossSigning,
    facts.value.crossSigningReady,
  );

const ownDeviceRefused = () =>
  new TrustOperationError(
    'delete-device',
    'stale-state',
    'none',
    'To sign out the device you are using, remove this account from the account menu.',
  );

function unwrap<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new EngineRequestError(result.failure);
  return result.value;
}

/**
 * Lists and manages the current user's devices (sessions). Device removal answers the
 * homeserver's password prompts from the caller's {@link PasswordPrompt}. Exposes the list
 * as a signal that rename/remove patch in place; {@link connect} keeps it live as the
 * device list changes elsewhere.
 */
@Injectable({ providedIn: 'root' })
export class TrustDevicesService {
  private readonly engine = inject(TRUST_ENGINE);
  private readonly session = inject(SessionStateService);

  private readonly _devices = signal<DeviceInfo[]>([]);
  readonly devices = this._devices.asReadonly();

  private readonly _canShareSecrets = signal(false);
  /**
   * This device caches all three private cross-signing keys and they match its identity,
   * so it can hand them to a device it links. Read with the device list and again whenever
   * trust changes. A local read: {@link holdsPublishedIdentity} asks the server at link time.
   */
  readonly canShareSecrets = this._canShareSecrets.asReadonly();

  /** Increments per load and per mutation, so a list read before a mutation cannot land after it. */
  private loadGen = 0;

  /**
   * Rebuild and reset are part of the Trust contract: an Account switch must never expose
   * the previous Account's sessions, and a detached projection must hold no stale device
   * identities or network metadata.
   */
  private readonly projection = projectActiveAccount<{
    readonly devices: EngineResult<readonly OwnDevice[]>;
    readonly facts: EngineResult<TrustFacts>;
    readonly gen: number;
  }>({
    id: 'crypto.devices',
    subscribe: (accountId) =>
      combineLatest([
        // Tagged when the list is read, so a later facts change cannot re-date it.
        this.engine
          .ownDevices(accountId)
          .pipe(map((devices) => ({ devices, gen: this.loadGen }))),
        this.engine.facts(accountId),
      ]).pipe(map(([{ devices, gen }, facts]) => ({ devices, facts, gen }))),
    rebuild: ({ devices, facts, gen }) => {
      // A failed read keeps the list it has.
      if (devices.ok && gen === this.loadGen) {
        this._devices.set(toDeviceInfos(devices.value));
      }
      this._canShareSecrets.set(canShareFrom(facts));
    },
    reset: () => {
      this.loadGen++;
      this._devices.set([]);
      this._canShareSecrets.set(false);
    },
  });

  /** Subscribe to live device-list changes; pair with {@link disconnect}. */
  connect(): void {
    this.projection.connect();
  }

  disconnect(): void {
    this.projection.disconnect();
  }

  /** Fetch all devices with their verification status (current device first). */
  list(): Observable<DeviceInfo[]> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) throw new EngineRequestError(NO_ACCOUNT);
      const gen = ++this.loadGen;
      this.engine
        .facts(accountId)
        .pipe(take(1))
        .subscribe((facts) => {
          if (this.session.activeAccountId() === accountId) {
            this._canShareSecrets.set(canShareFrom(facts));
          }
        });
      return this.engine.ownDevices(accountId).pipe(
        take(1),
        map((result) => {
          const devices = toDeviceInfos(unwrap(result));
          if (gen === this.loadGen) this._devices.set(devices);
          return devices;
        }),
      );
    }).pipe(recoverTrustOperation('list-devices'));
  }

  /**
   * Whether this device caches the private keys of the identity the homeserver publishes.
   * Asks the server first: that query also makes the crypto machine drop cached keys that
   * differ from the published ones, such as those a cancelled reset leaves behind.
   */
  holdsPublishedIdentity(accountId: string): Observable<boolean> {
    return this.engine.ownIdentityCheck(accountId).pipe(
      map((result) => {
        if (!result.ok && result.failure.code === 'crypto-not-ready') {
          return false;
        }
        const { publishedMasterKey, localMasterKey, facts } = unwrap(result);
        return (
          publishedMasterKey !== null &&
          localMasterKey === publishedMasterKey &&
          holdsCrossSigningIdentity(facts.crossSigning, facts.crossSigningReady)
        );
      }),
    );
  }

  /** Rename a device's public display name. */
  rename(deviceId: string, name: string): Observable<void> {
    const trimmed = name.trim();
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) throw new EngineRequestError(NO_ACCOUNT);
      return this.engine.renameDevice(accountId, deviceId, trimmed);
    }).pipe(
      map((result) => {
        unwrap(result);
        this.patch(deviceId, { displayName: trimmed || deviceId });
      }),
      recoverTrustOperation('rename-device'),
    );
  }

  /**
   * Delete (sign out) a device, answering the homeserver's password prompts —
   * `promptPassword` is asked for the account password and may be re-asked on a wrong
   * password. A cancelled prompt aborts.
   */
  delete(deviceId: string, promptPassword: PasswordPrompt): Observable<void> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) throw new EngineRequestError(NO_ACCOUNT);
      // Deleting the active session is logout (it revokes this token), not device
      // management — refuse here so an exported caller can't self-revoke.
      if (deviceId === this.session.status(accountId)?.deviceId) {
        throw ownDeviceRefused();
      }
      return answerPasswordPrompts(
        this.engine,
        accountId,
        this.engine.deleteDevice(accountId, deviceId),
        promptPassword,
      );
    }).pipe(
      map((result) => {
        // The person cancelled the password prompt: a silent no-op.
        if (!result.ok && result.failure.code === 'uia-cancelled') return;
        // The engine refuses its own device even when the session has no device id.
        if (!result.ok && result.failure.code === 'unsupported') {
          throw ownDeviceRefused();
        }
        unwrap(result);
        this.removeLocal(deviceId);
      }),
      recoverTrustOperation('delete-device'),
    );
  }

  private removeLocal(deviceId: string): void {
    this.loadGen++;
    this._devices.set(this._devices().filter((d) => d.id !== deviceId));
  }

  private patch(deviceId: string, partial: Partial<DeviceInfo>): void {
    this.loadGen++;
    this._devices.set(
      this._devices().map((d) =>
        d.id === deviceId ? { ...d, ...partial } : d,
      ),
    );
  }
}
