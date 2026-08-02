import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { TrnToastService } from '@trinity/helm/overlay';
import {
  PushRulesService,
  type PushRuleToggle,
} from '@trinity/data-access/notifications';
import { KeywordRulesBlockComponent } from './keyword-rules-block.component';
import { PushGatewayBlockComponent } from './push-gateway-block.component';

/**
 * Notifications settings sub-page: account-level toggles for which events notify,
 * backed by the homeserver's predefined push rules (via {@link PushRulesService}). Each
 * toggle is optimistic — it flips immediately and reverts with a toast if the write
 * fails. Changes sync to every device on the account.
 */
@Component({
  selector: 'trn-notifications-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notifications-section.component.html',
  imports: [HlmCheckbox, KeywordRulesBlockComponent, PushGatewayBlockComponent],
})
export class NotificationsSectionComponent implements OnInit {
  private readonly push = inject(PushRulesService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly toggles = this.push.toggles;

  /** The UI on/off state per rule id (optimistic; seeded from the synced rules). */
  private readonly state = signal<ReadonlyMap<string, boolean>>(new Map());
  /** Rule ids whose write is in flight. */
  private readonly pending = signal<ReadonlySet<string>>(new Set());

  ngOnInit(): void {
    const seeded = new Map<string, boolean>();
    for (const toggle of this.toggles) {
      seeded.set(toggle.id, this.push.isOn(toggle));
    }
    this.state.set(seeded);
  }

  checked(toggle: PushRuleToggle): boolean {
    return this.state().get(toggle.id) ?? false;
  }

  isPending(toggle: PushRuleToggle): boolean {
    return this.pending().has(toggle.id);
  }

  /** Optimistically flip a toggle and persist it; revert + toast on failure. */
  toggle(toggle: PushRuleToggle, on: boolean): void {
    if (this.isPending(toggle)) {
      return;
    }
    this.setState(toggle.id, on);
    this.setPending(toggle.id, true);
    this.push
      .setOn(toggle, on)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.setPending(toggle.id, false),
        error: () => {
          this.setState(toggle.id, !on); // revert the optimistic flip
          this.setPending(toggle.id, false);
          this.toast.show('Could not update your notification settings.', {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  private setState(id: string, on: boolean): void {
    this.state.update((current) => new Map(current).set(id, on));
  }

  private setPending(id: string, on: boolean): void {
    this.pending.update((set) => {
      const next = new Set(set);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }
}
