import { Injectable, inject, signal } from '@angular/core';
import { MatrixError, type AuthDict } from 'matrix-js-sdk';
import { Observable, defer, from, map, tap } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';
import type { PasswordPrompt } from './crypto.service';

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

const MAX_PASSWORD_ATTEMPTS = 3;

/**
 * Lists and manages the current user's devices (sessions), wrapping the SDK so
 * components never touch matrix-js-sdk directly. Device removal drives the
 * password user-interactive-auth (UIA) flow the homeserver requires. Exposes the
 * list as a signal that rename/remove patch in place.
 */
@Injectable({ providedIn: 'root' })
export class DevicesService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _devices = signal<DeviceInfo[]>([]);
  readonly devices = this._devices.asReadonly();

  /** Fetch all devices with their verification status (current device first). */
  list(): Observable<DeviceInfo[]> {
    return defer(() => from(this.loadDevices()));
  }

  private async loadDevices(): Promise<DeviceInfo[]> {
    const client = this.matrix.instance;
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
    this._devices.set(result);
    return result;
  }

  /** Rename a device's public display name. */
  rename(deviceId: string, name: string): Observable<void> {
    const trimmed = name.trim();
    return defer(() =>
      from(
        this.matrix.instance.setDeviceDetails(deviceId, {
          display_name: trimmed,
        }),
      ),
    ).pipe(
      tap(() => this.patch(deviceId, { displayName: trimmed || deviceId })),
      map(() => void 0),
    );
  }

  /**
   * Delete (sign out) a device, driving the password UIA when the homeserver
   * requires it — `promptPassword` is asked for the account password and may be
   * re-asked on a wrong password. A cancelled prompt aborts.
   */
  delete(deviceId: string, promptPassword: PasswordPrompt): Observable<void> {
    return defer(() => from(this.deleteWithUia(deviceId, promptPassword)));
  }

  private async deleteWithUia(
    deviceId: string,
    promptPassword: PasswordPrompt,
  ): Promise<void> {
    const client = this.matrix.instance;
    // Deleting the active session is logout (it revokes this token), not device
    // management — refuse here so an exported caller can't self-revoke.
    if (deviceId === client.getDeviceId()) {
      throw new Error('Use “Log out” to sign out the device you are using.');
    }

    // Many servers complete without UIA; a 401 carries the session + flows.
    let session: string;
    try {
      await client.deleteDevice(deviceId);
      this.removeLocal(deviceId);
      return;
    } catch (err) {
      const probe = uiaSession(err);
      if (!probe) {
        throw err;
      }
      session = probe;
    }

    for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt++) {
      const password = await promptPassword();
      if (password === null) {
        return; // user cancelled — a silent no-op, not an error
      }
      const auth: AuthDict = {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: client.getUserId() ?? '' },
        password,
        session,
      };
      try {
        await client.deleteDevice(deviceId, auth);
        this.removeLocal(deviceId);
        return;
      } catch (err) {
        const next = uiaSession(err);
        if (!next) {
          throw err; // a non-UIA failure (network/server) — give up
        }
        session = next; // wrong password / next stage — re-prompt
      }
    }
    throw new Error('Too many password attempts.');
  }

  private removeLocal(deviceId: string): void {
    this._devices.set(this._devices().filter((d) => d.id !== deviceId));
  }

  private patch(deviceId: string, partial: Partial<DeviceInfo>): void {
    this._devices.set(
      this._devices().map((d) =>
        d.id === deviceId ? { ...d, ...partial } : d,
      ),
    );
  }
}

/** A UIA 401 carries `flows` + a `session`; return the session, or null. */
function uiaSession(err: unknown): string | null {
  const data = err instanceof MatrixError ? err.data : undefined;
  if (data && 'flows' in data) {
    return (data as { session?: string }).session ?? null;
  }
  return null;
}
