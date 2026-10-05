import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnDialogService, TrnToastService } from '@trinity/components/overlay';
import {
  HomeserverInfoService,
  roomVersionStatus,
} from '@trinity/data-access/homeserver';
import {
  RoomSettingsService,
  type RoomAdvancedInfo,
} from '@trinity/data-access/room-administration';
import { DateTimeFormatService } from '@trinity/platform-native';
import { RoomStateViewerComponent } from '../room-state-viewer/room-state-viewer.component';
import { copyText } from '../shared/copy-text';

const VERSION_NOTES = {
  current: null,
  'newer-available': 'Newer version available',
  unstable: 'Unstable version',
} as const;

/** Read-only technical details of one Room, plus the room state viewer. */
@Component({
  selector: 'trn-room-settings-advanced',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  templateUrl: './room-settings-advanced.component.html',
  styleUrl: './room-settings-advanced.component.scss',
})
export class RoomSettingsAdvancedComponent implements OnInit {
  private readonly settings = inject(RoomSettingsService);
  private readonly homeservers = inject(HomeserverInfoService);
  private readonly dialog = inject(TrnDialogService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly fmt = inject(DateTimeFormatService);

  readonly accountId = input.required<string>();
  readonly info = input.required<RoomAdvancedInfo>();
  /** The room ID the reader asked to open (a predecessor or successor). */
  readonly openRoom = output<string>();

  readonly versionNote = computed(() => {
    const version = this.info().version;
    const capabilities =
      this.homeservers.infos().get(this.accountId())?.capabilities ?? null;
    const status =
      version === null ? null : roomVersionStatus(version, capabilities);
    return status ? VERSION_NOTES[status] : null;
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
    this.dialog.open(RoomStateViewerComponent, {
      ariaLabel: 'Room state',
      inputs: {
        entries: this.settings.stateEvents({
          accountId: this.accountId(),
          roomId: this.info().roomId,
        }),
      },
    });
  }
}
