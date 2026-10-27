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
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { InvitePermissionService } from '@trinity/data-access/room-library';
import { catchError, last, map, of } from 'rxjs';

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
  private readonly matrix = inject(SessionStateService);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * The choice shown ahead of the server. The native radio checks itself on click, so a failed
   * save must move the bound value back for the control to follow.
   */
  private readonly pending = signal<InviteChoice | null>(null);
  /** Writes still settling; the service runs them in order and finishes them if this closes. */
  private queued = 0;

  protected readonly options = OPTIONS;
  protected readonly supported = this.permission.supported;
  protected readonly error = signal<string | null>(null);
  /** With several accounts signed in, says which one the setting belongs to. */
  protected readonly description = computed(() => {
    const account = this.matrix.activeAccountId();
    return this.matrix.accountIds().length > 1 && account
      ? `Invites to ${account}.`
      : undefined;
  });
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
    this.queued += 1;
    this.permission
      .setBlocked(choice === 'block')
      .pipe(
        last(undefined, undefined),
        map(() => true),
        catchError(() => of(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((saved) => {
        this.queued -= 1;
        this.error.set(saved ? null : "Couldn't change this. Try again.");
        if (this.queued === 0) this.pending.set(null);
      });
  }
}
