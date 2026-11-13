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
import { TrustService, type VerifyBlock } from '@trinity/data-access/trust';

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
    this.checking() ? null : this.trust.verifyBlock(),
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

  protected open(flow: NonNullable<VerifyBlock['action']>['flow']): void {
    // Finite, and deliberately not tied to this component: its host closes on `opened`.
    this.surfaces.open({ surface: { kind: 'trust', flow } }).subscribe();
    this.opened.emit();
  }
}
