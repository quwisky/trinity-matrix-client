import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { IdentityChangeActionsService } from './identity-change-actions.service';
import type { IdentityChange } from './room-identity-changes.service';

/**
 * The buttons answering one person's changed identity, by what changed. Each is named with the
 * person, so a list of them stays distinct to a screen reader.
 */
@Component({
  selector: 'trn-identity-change-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  host: { class: 'inline-flex flex-wrap gap-2' },
  template: `
    @if (change().trust === 'identity-changed') {
      <button
        trnBtn
        size="sm"
        type="button"
        [disabled]="!!pending()"
        [attr.aria-label]="'Acknowledge ' + change().name + '’s new identity'"
        (click)="actions.acknowledge(change())"
        data-testid="identity-acknowledge"
      >
        {{ pending() === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge' }}
      </button>
    } @else {
      <button
        trnBtn
        size="sm"
        type="button"
        [disabled]="!!pending()"
        [attr.aria-label]="'Verify again: ' + change().name"
        (click)="verifyAgain()"
        data-testid="identity-verify-again"
      >
        {{ pending() === 'verify' ? 'Starting…' : 'Verify again' }}
      </button>
      <button
        trnBtn
        size="sm"
        variant="secondary"
        presentation="outline"
        type="button"
        [disabled]="!!pending()"
        [attr.aria-label]="'Withdraw verification for ' + change().name"
        (click)="actions.withdraw(change())"
        data-testid="identity-withdraw"
      >
        {{
          pending() === 'withdraw' ? 'Withdrawing…' : 'Withdraw verification'
        }}
      </button>
    }
  `,
})
export class IdentityChangeActionsComponent {
  protected readonly actions = inject(IdentityChangeActionsService);

  readonly change =
    input.required<Pick<IdentityChange, 'userId' | 'name' | 'trust'>>();
  /** The host starts verification itself (the member card), via {@link verifyRequested}. */
  readonly delegateVerify = input(false);

  readonly verifyRequested = output<void>();
  /** Verification started here; the host can close so it isn't covered. */
  readonly verificationStarted = output<void>();

  protected readonly pending = computed(() =>
    this.actions.pending(this.change().userId),
  );

  protected verifyAgain(): void {
    if (this.delegateVerify()) {
      this.verifyRequested.emit();
      return;
    }
    this.actions.verifyAgain(this.change(), () =>
      this.verificationStarted.emit(),
    );
  }
}
