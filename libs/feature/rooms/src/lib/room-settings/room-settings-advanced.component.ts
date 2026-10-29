import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { EMPTY, finalize, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
import {
  TrnSurfaceService,
  TrnSettingsGroupComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  HomeserverInfoService,
  roomVersionStatus,
} from '@trinity/data-access/homeserver';
import {
  RoomSettingsService,
  RoomUpgradeService,
  roomUpgradeTargets,
  type ActionAvailability,
  type RoomAdvancedInfo,
  type RoomUpgradeResult,
} from '@trinity/data-access/room-administration';
import { DateTimeFormatService } from '@trinity/platform-native';
import { RoomStateViewerComponent } from '../room-state-viewer/room-state-viewer.component';
import {
  ROOM_UPGRADE_WARNING_ID,
  RoomUpgradeDialogComponent,
} from '../room-upgrade/room-upgrade-dialog.component';
import { copyText } from '../shared/copy-text';

const VERSION_NOTES = {
  current: null,
  'newer-available': 'Newer version available',
  unstable: 'Unstable version',
} as const;

const NOT_ALLOWED: ActionAvailability = { available: false, reason: null };

/** Technical details of one Room, the room state viewer, and Upgrade room. */
@Component({
  selector: 'trn-room-settings-advanced',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnActionAvailability, TrnButton, TrnSettingsGroupComponent],
  templateUrl: './room-settings-advanced.component.html',
  styleUrl: './room-settings-advanced.component.scss',
})
export class RoomSettingsAdvancedComponent implements OnInit {
  private readonly settings = inject(RoomSettingsService);
  private readonly upgrades = inject(RoomUpgradeService);
  private readonly homeservers = inject(HomeserverInfoService);
  private readonly dialog = inject(TrnSurfaceService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly capabilities = computed(
    () => this.homeservers.infos().get(this.accountId())?.capabilities ?? null,
  );
  protected readonly fmt = inject(DateTimeFormatService);
  protected readonly loadingState = signal(false);
  protected readonly loadingPlan = signal(false);

  readonly accountId = input.required<string>();
  readonly info = input.required<RoomAdvancedInfo>();
  /** Whether this Account may upgrade the room (send `m.room.tombstone`). */
  readonly upgrade = input<ActionAvailability>(NOT_ALLOWED);
  /** The room ID the reader asked to open (a predecessor, successor or upgraded room). */
  readonly openRoom = output<string>();

  readonly versionNote = computed(() => {
    const version = this.info().version;
    const status =
      version === null ? null : roomVersionStatus(version, this.capabilities());
    return status ? VERSION_NOTES[status] : null;
  });
  /** Why Upgrade room is disabled, or null when there is a version to move to. */
  readonly upgradeBlockedReason = computed(() => {
    if (this.info().successor) return 'This room has already been upgraded.';
    return roomUpgradeTargets(this.info().version, this.capabilities())
      .length === 0
      ? 'This room is already on the newest version the server offers.'
      : null;
  });
  readonly creators = computed(() =>
    this.info().createdBy.map(({ userId, displayName }) =>
      displayName === userId ? userId : `${displayName} (${userId})`,
    ),
  );
  readonly federation = computed(() => {
    const federated = this.info().federated;
    if (federated === null) return 'Unknown';
    return federated ? 'Other servers can join' : 'This server only';
  });

  ngOnInit(): void {
    // Best-effort and cached for the session; without an answer there is simply no note.
    this.homeservers
      .load(this.accountId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  copy(value: string, what: string): void {
    copyText(value, what, this.toast);
  }

  viewState(): void {
    this.loadingState.set(true);
    this.settings
      .stateEvents({ accountId: this.accountId(), roomId: this.info().roomId })
      .pipe(
        finalize(() => this.loadingState.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (entries) =>
          this.dialog.open(RoomStateViewerComponent, { inputs: { entries } }),
        error: () =>
          this.toast.show('Could not load the room state.', {
            variant: 'danger',
          }),
      });
  }

  openUpgrade(): void {
    if (this.loadingPlan()) return;
    const accountId = this.accountId();
    const roomId = this.info().roomId;
    this.loadingPlan.set(true);
    this.upgrades
      .plan(accountId, roomId, this.capabilities())
      .pipe(
        // Upstream of the dialog: the plan, not the dialog, is what is loading.
        finalize(() => this.loadingPlan.set(false)),
        switchMap((plan) =>
          !plan || plan.targets.length === 0
            ? EMPTY
            : this.dialog.openAndWait$<
                RoomUpgradeResult,
                RoomUpgradeDialogComponent
              >(RoomUpgradeDialogComponent, {
                ariaDescribedBy: ROOM_UPGRADE_WARNING_ID,
                // Closing mid-run would hide a workflow that keeps going.
                dismissGuard: (dialog) => !dialog?.busy(),
                inputs: { accountId, roomId, plan },
              }),
        ),
        // If Room settings closed mid-run, the dialog still finishes and toasts; nothing opens.
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((result) => {
        if (result) this.openRoom.emit(result.newRoomId);
      });
  }
}
