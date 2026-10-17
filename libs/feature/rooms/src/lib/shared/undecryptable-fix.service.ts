import { Injectable, computed, inject, type Signal } from '@angular/core';
import { Observable, defer, map, of } from 'rxjs';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { TrustService, type TrustStatus } from '@trinity/data-access/trust';

/** What an unreadable message's button opens. */
export type UndecryptableFixTarget = 'unlock' | 'verify' | 'setup' | 'security';

/** The one action an unreadable message offers, when this device can apply it. */
export interface UndecryptableFix {
  readonly label:
    'Verify this device' | 'Use recovery key' | 'Security settings';
  readonly target: UndecryptableFixTarget;
}

const VERIFY_WITH_RECOVERY_KEY: UndecryptableFix = Object.freeze({
  label: 'Verify this device',
  target: 'unlock',
});
const VERIFY_WITH_OTHER_DEVICE: UndecryptableFix = Object.freeze({
  label: 'Verify this device',
  target: 'verify',
});
const SET_UP_ENCRYPTION: UndecryptableFix = Object.freeze({
  label: 'Verify this device',
  target: 'setup',
});
const USE_RECOVERY_KEY: UndecryptableFix = Object.freeze({
  label: 'Use recovery key',
  target: 'unlock',
});
const SECURITY_SETTINGS: UndecryptableFix = Object.freeze({
  label: 'Security settings',
  target: 'security',
});

/**
 * The button for a message this device could not decrypt, from this device's trust status. An
 * account with no identity has nothing to verify against, so "Verify this device" opens setup, as
 * the encryption banner does.
 */
export function deriveUndecryptableFix(
  status: TrustStatus,
  thisDeviceVerified: boolean | null,
  recoverySetupElsewhere: boolean,
): UndecryptableFix | null {
  if (status === 'unknown') return null;
  if (thisDeviceVerified) {
    if (recoverySetupElsewhere) return SECURITY_SETTINGS;
    return status === 'needs-recovery' ? USE_RECOVERY_KEY : null;
  }
  switch (status) {
    case 'needs-recovery':
      return VERIFY_WITH_RECOVERY_KEY;
    case 'needs-verification':
      return VERIFY_WITH_OTHER_DEVICE;
    case 'needs-setup':
      return SET_UP_ENCRYPTION;
    case 'ready':
      return null;
    default: {
      const unhandled: never = status;
      void unhandled;
      return null;
    }
  }
}

function surfaceFor(
  target: UndecryptableFixTarget,
): WorkspaceApplicationSurfaceRequest {
  switch (target) {
    case 'security':
      return { surface: { kind: 'settings', section: 'security' } };
    case 'unlock':
    case 'verify':
    case 'setup':
      return { surface: { kind: 'trust', flow: target } };
    default: {
      const unhandled: never = target;
      void unhandled;
      return unhandled;
    }
  }
}

/**
 * Derives the unreadable-message button from Trust's live status and opens the trust surface it
 * names. Rows stay presentational: they receive {@link fix} and raise one row action, which the
 * shared dispatcher routes to {@link open}.
 */
@Injectable({ providedIn: 'root' })
export class UndecryptableFixService {
  private readonly trust = inject(TrustService);
  private readonly surfaces = inject(WorkspaceApplicationSurfaceService);

  readonly fix: Signal<UndecryptableFix | null> = computed(() =>
    deriveUndecryptableFix(
      this.trust.status(),
      this.trust.thisDeviceVerified(),
      this.trust.recoverySetupElsewhere(),
    ),
  );

  /** Open the surface the current status names; re-read at click time. */
  open(): Observable<void> {
    return defer(() => {
      const fix = this.fix();
      if (!fix) return of(undefined);
      return this.surfaces
        .open(surfaceFor(fix.target))
        .pipe(map(() => undefined));
    });
  }
}
