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
  NotificationSoundService,
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
  private readonly sound = inject(NotificationSoundService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly toggles = this.push.toggles;

  /** The UI on/off state per rule id (optimistic; seeded from the synced rules). */
  private readonly state = signal<ReadonlyMap<string, boolean>>(new Map());
  /** Rule ids whose write is in flight. */
  private readonly pending = signal<ReadonlySet<string>>(new Set());

  /**
   * Key for the sound switch in the same optimistic state/pending maps as the rule toggles.
   * Not a rule id: it stands for the `sound` tweak across SEVEN predefined rules at once, so
   * it cannot borrow any single one of theirs.
   */
  protected readonly soundKey = 'trinity.notification-sound';

  ngOnInit(): void {
    const seeded = new Map<string, boolean>();
    for (const toggle of this.toggles) {
      seeded.set(toggle.id, this.push.isOn(toggle));
    }
    seeded.set(this.soundKey, this.sound.isOn());
    this.state.set(seeded);
  }

  soundChecked(): boolean {
    return this.state().get(this.soundKey) ?? false;
  }

  soundPending(): boolean {
    return this.pending().has(this.soundKey);
  }

  /** Optimistically flip the sound switch and persist it; revert + toast on failure. */
  toggleSound(on: boolean): void {
    if (this.soundPending()) {
      return;
    }
    this.setState(this.soundKey, on);
    this.setPending(this.soundKey, true);
    this.sound
      .setOn(on)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.setPending(this.soundKey, false),
        error: () => {
          this.setState(this.soundKey, !on);
          this.setPending(this.soundKey, false);
          this.toast.show('Could not update your notification settings.', {
            variant: 'destructive',
          });
        },
      });
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
