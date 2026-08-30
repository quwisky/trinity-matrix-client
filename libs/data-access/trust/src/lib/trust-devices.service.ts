import { Injectable, inject, signal } from '@angular/core';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { Observable, defer, from, map, tap } from 'rxjs';
import {
  TrustCryptoPort,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import {
  TrustOperationError,
  recoverTrustOperation,
} from './trust-operation-error';
import {
  UiaCancelledError,
  runPasswordUia,
  type PasswordPrompt,
} from '@trinity/util/matrix';

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

/**
 * Lists and manages the current user's devices (sessions), wrapping the SDK so
 * components never touch matrix-js-sdk directly. Device removal drives the
 * password user-interactive-auth (UIA) flow the homeserver requires. Exposes the
 * list as a signal that rename/remove patch in place; {@link connect} keeps it
 * live as the device list changes elsewhere.
 */
@Injectable({ providedIn: 'root' })
export class TrustDevicesService {
  private readonly cryptoPort = inject(TrustCryptoPort);

  private readonly _devices = signal<DeviceInfo[]>([]);
  readonly devices = this._devices.asReadonly();

  /** Increments per load (and per mutation) so a stale reload can't clobber. */
  private loadGen = 0;

  /** Refresh only when OUR session list could have changed — the event also fires
   * for other users we share encrypted rooms with (and on the initial fetch). */
  private readonly onDevicesUpdated = (
    users: string[],
    initialFetch?: boolean,
  ): void => {
    if (initialFetch || !this.cryptoPort.isAvailable()) {
      return;
    }
    const me = this.cryptoPort.active().client.getUserId();
    if (me && users.includes(me)) {
      void this.loadDevices().catch(() => undefined);
    }
  };

  /**
   * The projection. `onDevicesUpdated` is bound by hand because it reads the event's
   * arguments to decide whether OUR session list changed, so there is nothing to coalesce.
   *
   * Rebuild and reset are part of the Trust contract: an Account switch must never expose
   * the previous Account's sessions, and a detached projection must hold no stale device
   * identities or network metadata.
   */
  private readonly projection = this.cryptoPort.project({
    id: 'crypto.devices',
    bind: (client) =>
      client.on(CryptoEvent.DevicesUpdated, this.onDevicesUpdated),
    unbind: (client) =>
      client.off(CryptoEvent.DevicesUpdated, this.onDevicesUpdated),
    rebuild: (client) => void this.loadDevices(client).catch(() => undefined),
    reset: () => {
      this.loadGen++;
      this._devices.set([]);
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
    return defer(() => from(this.loadDevices())).pipe(
      recoverTrustOperation('list-devices'),
    );
  }

  private async loadDevices(
    projectedClient?: TrustMatrixClient,
  ): Promise<DeviceInfo[]> {
    const gen = ++this.loadGen;
    const client = projectedClient ?? this.cryptoPort.active().client;
    const userId = client.getUserId() ?? '';
    const currentId = client.getDeviceId();
    const crypto = client.getCrypto();
    const { devices } = await client.getDevices();

    const result = await Promise.all(
      devices.map(async (d): Promise<DeviceInfo> => {
        // Verification status is decorative — a transient crypto/store error on
        // one device must not fail the whole list, so degrade it to unverified.
        const status = crypto
          ? await crypto
              .getDeviceVerificationStatus(userId, d.device_id)
              .catch(() => null)
          : null;
        return {
          id: d.device_id,
          displayName: d.display_name || d.device_id,
          lastSeenTs: d.last_seen_ts ?? null,
          lastSeenIp: d.last_seen_ip ?? null,
          isCurrent: d.device_id === currentId,
          isVerified: status?.isVerified() ?? false,
        };
      }),
    );
    // Current device first, then most-recently-seen.
    result.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) {
        return a.isCurrent ? -1 : 1;
      }
      return (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0);
    });
    // Drop a stale result if a newer load — or a mutation (rename/remove) — has
    // happened since this one began, so a slow reload can't resurrect a device.
    if (gen === this.loadGen) {
      this._devices.set(result);
    }
    return result;
  }

  /** Rename a device's public display name. */
  rename(deviceId: string, name: string): Observable<void> {
    const trimmed = name.trim();
    return defer(() =>
      from(
        this.cryptoPort.active().client.setDeviceDetails(deviceId, {
          display_name: trimmed,
        }),
      ),
    ).pipe(
      tap(() => this.patch(deviceId, { displayName: trimmed || deviceId })),
      map(() => void 0),
      recoverTrustOperation('rename-device'),
    );
  }

  /**
   * Delete (sign out) a device, driving the password UIA when the homeserver
   * requires it — `promptPassword` is asked for the account password and may be
   * re-asked on a wrong password. A cancelled prompt aborts.
   */
  delete(deviceId: string, promptPassword: PasswordPrompt): Observable<void> {
    return defer(() => from(this.deleteWithUia(deviceId, promptPassword))).pipe(
      recoverTrustOperation('delete-device'),
    );
  }

  private async deleteWithUia(
    deviceId: string,
    promptPassword: PasswordPrompt,
  ): Promise<void> {
    const client = this.cryptoPort.active().client;
    // Deleting the active session is logout (it revokes this token), not device
    // management — refuse here so an exported caller can't self-revoke.
    if (deviceId === client.getDeviceId()) {
      throw new TrustOperationError(
        'delete-device',
        'stale-state',
        'none',
        'Use “Log out” to sign out the device you are using.',
      );
    }
    try {
      await runPasswordUia(
        (auth) => client.deleteDevice(deviceId, auth ?? undefined),
        promptPassword,
        client.getUserId() ?? '',
      );
    } catch (err) {
      if (err instanceof UiaCancelledError) {
        return; // user cancelled the password prompt — a silent no-op
      }
      throw err;
    }
    this.removeLocal(deviceId);
  }

  private removeLocal(deviceId: string): void {
    this.loadGen++; // invalidate any in-flight reload that predates this removal
    this._devices.set(this._devices().filter((d) => d.id !== deviceId));
  }

  private patch(deviceId: string, partial: Partial<DeviceInfo>): void {
    this.loadGen++; // invalidate any in-flight reload that predates this edit
    this._devices.set(
      this._devices().map((d) =>
        d.id === deviceId ? { ...d, ...partial } : d,
      ),
    );
  }
}
