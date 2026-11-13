import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrustService, type TrustStatus } from '@trinity/data-access/trust';

/** What stands where Verify would be: a reason, and the trust flow that fixes it, if any. */
export interface VerifyBlock {
  readonly reason: string;
  readonly action: {
    readonly label: string;
    readonly flow: 'setup' | 'unlock' | 'verify';
  } | null;
}

const ENTER_RECOVERY_KEY: VerifyBlock = {
  reason:
    'This device doesn’t have all its keys yet. Enter your recovery key to verify people.',
  action: { label: 'Enter recovery key', flow: 'unlock' },
};
const VERIFY_THIS_DEVICE: VerifyBlock = {
  reason: 'Verify this device before you verify people.',
  action: { label: 'Verify this device', flow: 'verify' },
};
const SET_UP_ENCRYPTION: VerifyBlock = {
  reason: 'Set up encryption on this device to verify people.',
  action: { label: 'Set up encryption', flow: 'setup' },
};
// No action: the only one this device could offer is replacing the identity.
const KEYS_ON_ANOTHER_DEVICE: VerifyBlock = {
  reason:
    'Verify people from the device where you set up encryption, or set up recovery there.',
  action: null,
};

/**
 * Why a device without its user-signing key cannot verify people, and the existing flow
 * that brings the key here. With recovery (`ready` included: secret storage counts as
 * ready without the keys being on this device) that is the recovery key.
 */
export function deriveVerifyBlock(
  status: TrustStatus,
  recoverySetupElsewhere: boolean,
): VerifyBlock | null {
  switch (status) {
    case 'ready':
    case 'needs-recovery':
      return ENTER_RECOVERY_KEY;
    case 'needs-verification':
      return VERIFY_THIS_DEVICE;
    case 'needs-setup':
      return recoverySetupElsewhere
        ? KEYS_ON_ANOTHER_DEVICE
        : SET_UP_ENCRYPTION;
    case 'unknown':
      return null;
    default: {
      const unhandled: never = status;
      void unhandled;
      return null;
    }
  }
}

let nextId = 0;

/**
 * Stands where Verify would be on a device that cannot sign other users: says why, and
 * opens the trust flow that fixes it. Reads state and routes only.
 */
@Component({
  selector: 'trn-verify-needs-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  host: {
    class: 'flex flex-col gap-2',
    '[class.items-start]': '!centered()',
    '[class.items-center]': 'centered()',
    '[class.text-center]': 'centered()',
    'data-testid': 'verify-needs-setup',
  },
  template: `
    @if (block(); as block) {
      <p class="text-sm text-muted-foreground" [id]="reasonId">
        {{ block.reason }}
      </p>
      @if (block.action; as action) {
        <button
          trnBtn
          size="sm"
          presentation="outline"
          type="button"
          [attr.aria-describedby]="reasonId"
          (click)="open(action.flow)"
        >
          {{ action.label }}
        </button>
      }
    } @else {
      <p class="text-sm text-muted-foreground">Checking this device…</p>
    }
  `,
})
export class VerifyNeedsSetupComponent {
  private readonly surfaces = inject(WorkspaceApplicationSurfaceService);
  private readonly trust = inject(TrustService);

  /**
   * The projected key status follows health events only, and the keys can land without
   * one. Nothing is asked of the user until a fresh read has had its say: if the keys are
   * here after all, the host swaps this for Verify.
   */
  private readonly checking = signal(true);

  protected readonly reasonId = `verify-needs-setup-${nextId++}`;
  protected readonly block = computed(() =>
    this.checking()
      ? null
      : deriveVerifyBlock(
          this.trust.status(),
          this.trust.recoverySetupElsewhere(),
        ),
  );

  readonly centered = input(false);

  /** A trust flow is opening; a host that would cover it can close. */
  readonly opened = output<void>();

  constructor() {
    this.trust
      .refresh()
      .pipe(
        finalize(() => this.checking.set(false)),
        takeUntilDestroyed(),
      )
      .subscribe({ error: () => undefined });
  }

  protected open(flow: 'setup' | 'unlock' | 'verify'): void {
    // Finite, and deliberately not tied to this component: its host closes on `opened`.
    this.surfaces.open({ surface: { kind: 'trust', flow } }).subscribe();
    this.opened.emit();
  }
}
