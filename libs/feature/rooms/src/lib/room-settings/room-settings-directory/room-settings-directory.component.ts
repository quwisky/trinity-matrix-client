import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton, TrnSwitchComponent } from '@trinity/components/controls';
import { TrnSettingsRowComponent } from '@trinity/components/overlay';
import { RoomDirectoryService } from '@trinity/data-access/room-administration';
import { Subject, catchError, map, of, startWith, switchMap } from 'rxjs';
import { RoomSettingsDraftService } from '../room-settings-draft.service';
import { settingsActionFailure } from '../settings-action-failure';

type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'loaded'; readonly listed: boolean };

const SWITCH_ID = 'room-settings-directory-switch';

/** Room settings › Addresses: list the room in its account's homeserver directory. */
@Component({
  selector: 'trn-room-settings-directory',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnSettingsRowComponent, TrnSwitchComponent],
  templateUrl: './room-settings-directory.component.html',
  styleUrl: './room-settings-directory.component.scss',
})
export class RoomSettingsDirectoryComponent implements OnInit {
  private readonly draft = inject(RoomSettingsDraftService);
  private readonly directory = inject(RoomDirectoryService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reloads = new Subject<void>();
  private readonly listingState = signal<Listing>({ kind: 'loading' });
  private readonly savingState = signal(false);
  private readonly errorState = signal<string | null>(null);
  private readonly target = computed(
    () => this.draft.snapshot()?.target ?? null,
  );

  readonly switchId = SWITCH_ID;
  readonly reasonId = `${SWITCH_ID}-reason`;
  readonly errorId = `${SWITCH_ID}-error`;
  readonly listing = this.listingState.asReadonly();
  readonly listed = computed(() => {
    const listing = this.listing();
    return listing.kind === 'loaded' && listing.listed;
  });
  readonly saving = this.savingState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly server = computed(() => {
    const target = this.target();
    return (target && this.directory.serverName(target)) ?? 'your server';
  });
  readonly label = computed(() => `List in ${this.server()}'s room directory`);
  readonly hint = computed(
    () =>
      `People on ${this.server()} can find this room by searching. They still need to meet the joining rule to get in.`,
  );
  readonly permission = computed(() => this.draft.permissions().directory);
  readonly mayChange = computed(
    () => this.draft.targetAvailable() && this.permission().available,
  );
  readonly describedBy = computed(() =>
    [
      `${SWITCH_ID}-description`,
      this.permission().available ? null : this.reasonId,
      this.error() ? this.errorId : null,
    ]
      .filter(Boolean)
      .join(' '),
  );

  ngOnInit(): void {
    this.reloads
      .pipe(
        startWith(undefined),
        switchMap(() => {
          const target = this.target();
          if (!target) return of<Listing>({ kind: 'failed' });
          return this.directory.listed(target).pipe(
            map((listed): Listing => ({ kind: 'loaded', listed })),
            catchError(() => of<Listing>({ kind: 'failed' })),
            startWith<Listing>({ kind: 'loading' }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((listing) => this.listingState.set(listing));
  }

  reload(): void {
    this.reloads.next();
  }

  /** Applies at once; the switch shows the new value and reverts if the server refuses. */
  setListed(listed: boolean): void {
    const target = this.target();
    const current = this.listing();
    if (!target || current.kind !== 'loaded' || this.saving()) return;
    if (!this.mayChange() || current.listed === listed) return;
    this.listingState.set({ kind: 'loaded', listed });
    this.savingState.set(true);
    this.errorState.set(null);
    this.directory
      .setListed(target, listed)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => this.savingState.set(false),
        error: (error: unknown) => {
          this.savingState.set(false);
          this.listingState.set({ kind: 'loaded', listed: !listed });
          this.errorState.set(
            settingsActionFailure(
              error,
              "Couldn't change the directory listing. Try again.",
            ),
          );
        },
      });
  }
}
