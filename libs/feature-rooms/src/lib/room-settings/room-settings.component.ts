import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { type Observable, catchError, forkJoin, map, of } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import {
  HistoryVisibility,
  JoinRule,
  RoomSettingsService,
} from '@trinity/data-access-rooms';
import { AvatarComponent } from '@trinity/ui';
import { initialOf } from '@trinity/util-matrix';
import { BannedMembersComponent } from '../banned-members/banned-members.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';

/** Reject avatar uploads larger than this (before hitting a server 413). */
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

/** The join-rule choices offered (a practical subset of the spec's options). */
const JOIN_RULE_OPTIONS = [
  { value: JoinRule.Invite, label: 'Invite only' },
  { value: JoinRule.Public, label: 'Anyone can join' },
] as const;

/** The history-visibility choices offered, from most to least open. */
const HISTORY_OPTIONS = [
  { value: HistoryVisibility.Shared, label: 'Members — all history' },
  {
    value: HistoryVisibility.Invited,
    label: 'Members — since they were invited',
  },
  { value: HistoryVisibility.Joined, label: 'Members — since they joined' },
  {
    value: HistoryVisibility.WorldReadable,
    label: 'Anyone, even without joining',
  },
] as const;

/**
 * Dialog to edit a room's identity (name/topic/avatar) and access controls (join rule +
 * history visibility). The opener seeds the current values and which fields the viewer's
 * power level lets them change; fields they can't edit render read-only. Save writes only
 * the fields that changed and closes resolving `true` (so the host can refresh/toast);
 * errors keep the dialog open with a toast. Viewers who can ban also see the room's banned
 * members (with an Unban action) via {@link BannedMembersComponent}. Presented via
 * {@link TrnDialogService}.
 */
@Component({
  selector: 'trn-room-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    HlmButton,
    HlmInput,
    AvatarComponent,
    BannedMembersComponent,
    RoomAliasesComponent,
  ],
  templateUrl: './room-settings.component.html',
  styleUrl: './room-settings.component.scss',
})
export class RoomSettingsComponent implements OnInit {
  readonly roomId = input.required<string>();
  readonly name = input('');
  readonly topic = input('');
  readonly avatarMxc = input<string | null>(null);
  readonly joinRule = input<JoinRule>(JoinRule.Invite);
  readonly historyVisibility = input<HistoryVisibility>(
    HistoryVisibility.Shared,
  );
  readonly canEditName = input(false);
  readonly canEditTopic = input(false);
  readonly canEditAvatar = input(false);
  readonly canEditJoinRule = input(false);
  readonly canEditHistory = input(false);
  /** Whether the viewer may manage (view + lift) this room's bans. */
  readonly canManageBans = input(false);
  /** Whether the viewer may manage this room's published addresses. */
  readonly canManageAliases = input(false);

  private readonly dialogRef =
    inject<DialogRef<boolean, RoomSettingsComponent>>(DialogRef);
  private readonly settings = inject(RoomSettingsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly avatarInput =
    viewChild<ElementRef<HTMLInputElement>>('avatarInput');

  /** True while the save writes are in flight (disables the form + Save). */
  readonly saving = signal(false);
  /** True while an avatar upload is in flight. */
  readonly savingAvatar = signal(false);
  /** First letter of the room name, for the avatar fallback. */
  readonly avatarInitial = computed(() => initialOf(this.name()));

  /** Whether the Save button applies to anything the viewer can change. */
  readonly canSave = computed(
    () =>
      this.canEditName() ||
      this.canEditTopic() ||
      this.canEditJoinRule() ||
      this.canEditHistory(),
  );

  readonly joinRuleOptions = JOIN_RULE_OPTIONS;
  readonly historyOptions = HISTORY_OPTIONS;

  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    topic: new FormControl('', { nonNullable: true }),
    joinRule: new FormControl<JoinRule>(JoinRule.Invite, { nonNullable: true }),
    historyVisibility: new FormControl<HistoryVisibility>(
      HistoryVisibility.Shared,
      { nonNullable: true },
    ),
  });

  ngOnInit(): void {
    this.form.setValue({
      name: this.name(),
      topic: this.topic(),
      joinRule: this.joinRule(),
      historyVisibility: this.historyVisibility(),
    });
    if (!this.canEditName()) {
      this.form.controls.name.disable();
    }
    if (!this.canEditTopic()) {
      this.form.controls.topic.disable();
    }
    if (!this.canEditJoinRule()) {
      this.form.controls.joinRule.disable();
    }
    if (!this.canEditHistory()) {
      this.form.controls.historyVisibility.disable();
    }
  }

  /**
   * Persist each changed, editable field independently and report the real outcome:
   * close on full success; on failure keep the dialog open with a toast that names what
   * did and didn't save (each write is its own state event, so a partial failure is
   * possible and must not claim "nothing saved"). Re-Saving is idempotent.
   */
  save(): void {
    const roomId = this.roomId();
    const name = this.form.controls.name.value.trim();
    const topic = this.form.controls.topic.value.trim();
    const writes: { field: string; op: Observable<void> }[] = [];
    // A room name shouldn't be blanked from here — only write a non-empty change.
    if (this.canEditName() && name && name !== this.name().trim()) {
      writes.push({ field: 'name', op: this.settings.setName(roomId, name) });
    }
    if (this.canEditTopic() && topic !== this.topic().trim()) {
      writes.push({
        field: 'topic',
        op: this.settings.setTopic(roomId, topic),
      });
    }
    const joinRule = this.form.controls.joinRule.value;
    if (this.canEditJoinRule() && joinRule !== this.joinRule()) {
      writes.push({
        field: 'join rule',
        op: this.settings.setJoinRule(roomId, joinRule),
      });
    }
    const historyVisibility = this.form.controls.historyVisibility.value;
    if (
      this.canEditHistory() &&
      historyVisibility !== this.historyVisibility()
    ) {
      writes.push({
        field: 'history visibility',
        op: this.settings.setHistoryVisibility(roomId, historyVisibility),
      });
    }
    if (writes.length === 0) {
      this.dialogRef.close(false);
      return;
    }
    this.saving.set(true);
    forkJoin(
      writes.map(({ field, op }) =>
        op.pipe(
          map(() => ({ field, ok: true })),
          catchError(() => of({ field, ok: false })),
        ),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((results) => {
        const failed = results.filter((r) => !r.ok).map((r) => r.field);
        if (failed.length === 0) {
          this.dialogRef.close(true);
          return;
        }
        const saved = results.filter((r) => r.ok).map((r) => r.field);
        this.saving.set(false);
        this.toast.show(
          saved.length
            ? `Saved the ${saved.join(' and ')}, but couldn't update the ${failed.join(' and ')}.`
            : 'Could not save room settings.',
          { duration: 4000, variant: 'destructive' },
        );
      });
  }

  /** Open the hidden file input to choose a new room photo. */
  pickAvatar(): void {
    this.avatarInput()?.nativeElement.click();
  }

  /** Validate + upload the picked image as the room avatar; toast the outcome. */
  onAvatarPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (!file) {
      return;
    }
    // accept="image/*" is only a picker hint — validate before uploading.
    if (!file.type.startsWith('image/')) {
      this.showError('Please choose an image file.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      this.showError('That image is too large (max 8 MB).');
      return;
    }
    this.savingAvatar.set(true);
    this.settings
      .setAvatar(this.roomId(), file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.savingAvatar.set(false);
          this.toast.show('Room photo updated.', {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.savingAvatar.set(false);
          this.showError('Could not update the room photo.');
        },
      });
  }

  close(): void {
    this.dialogRef.close(false);
  }

  private showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'destructive' });
  }
}
