import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
} from '@trinity/components/overlay';
import { InvitePermissionService } from '@trinity/data-access/room-library';
import { Subscription } from 'rxjs';

type InviteChoice = 'allow' | 'block';

const OPTIONS: readonly TrnRadioOption<InviteChoice>[] = [
  {
    value: 'allow',
    label: 'Allow all invites',
    testId: 'privacy-invites-allow',
  },
  {
    value: 'block',
    label: 'Block all invites',
    description:
      'Your server turns down every invite. People who invite you see an error, and invites you already have are hidden.',
    testId: 'privacy-invites-block',
  },
];

/** Settings › Privacy › Invites: the server-enforced "Who can invite you" choice. */
@Component({
  selector: 'trn-invite-permission-setting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './invite-permission-setting.component.html',
  imports: [
    TrnSettingsGroupComponent,
    TrnSettingsRowComponent,
    TrnRadioGroupComponent,
  ],
})
export class InvitePermissionSettingComponent {
  private readonly permission = inject(InvitePermissionService);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * The choice shown ahead of the server. The native radio checks itself on click, so a failed
   * save must move the bound value back for the control to follow.
   */
  private readonly pending = signal<InviteChoice | null>(null);
  private saving$ = Subscription.EMPTY;

  protected readonly options = OPTIONS;
  protected readonly supported = this.permission.supported;
  protected readonly error = signal<string | null>(null);
  protected readonly choice = computed<InviteChoice>(
    () => this.pending() ?? (this.permission.blocked() ? 'block' : 'allow'),
  );

  constructor() {
    this.permission
      .runProjection()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected choose(choice: InviteChoice): void {
    if (choice === this.choice()) return;
    this.error.set(null);
    this.pending.set(choice);
    // The newer choice wins; the radios stay enabled so keyboard focus is never dropped.
    this.saving$.unsubscribe();
    this.saving$ = this.permission
      .setBlocked(choice === 'block')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.pending.set(null),
        error: () => {
          this.pending.set(null);
          this.error.set("Couldn't change this. Try again.");
        },
      });
  }
}
