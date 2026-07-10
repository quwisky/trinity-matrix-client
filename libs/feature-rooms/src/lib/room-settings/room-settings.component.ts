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
import { type Observable, forkJoin } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { RoomSettingsService } from '@trinity/data-access-rooms';
import { AvatarComponent } from '@trinity/ui';
import { initialOf } from '@trinity/util-matrix';

/** Reject avatar uploads larger than this (before hitting a server 413). */
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

/**
 * Dialog to edit a room's name and topic (`m.room.name` / `m.room.topic`). The opener
 * seeds the current values and which fields the viewer's power level lets them change;
 * fields they can't edit render read-only. Save writes only the fields that changed and
 * closes resolving `true` (so the host can refresh/toast); errors keep the dialog open
 * with a toast. Presented via {@link TrnDialogService}.
 */
@Component({
  selector: 'trn-room-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, HlmButton, HlmInput, AvatarComponent],
  templateUrl: './room-settings.component.html',
  styleUrl: './room-settings.component.scss',
})
export class RoomSettingsComponent implements OnInit {
  readonly roomId = input.required<string>();
  readonly name = input('');
  readonly topic = input('');
  readonly avatarMxc = input<string | null>(null);
  readonly canEditName = input(false);
  readonly canEditTopic = input(false);
  readonly canEditAvatar = input(false);

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

  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    topic: new FormControl('', { nonNullable: true }),
  });

  ngOnInit(): void {
    this.form.setValue({ name: this.name(), topic: this.topic() });
    if (!this.canEditName()) {
      this.form.controls.name.disable();
    }
    if (!this.canEditTopic()) {
      this.form.controls.topic.disable();
    }
  }

  /** Persist the changed, editable fields; close on success, toast on failure. */
  save(): void {
    const roomId = this.roomId();
    const name = this.form.controls.name.value.trim();
    const topic = this.form.controls.topic.value.trim();
    const writes: Observable<void>[] = [];
    // A room name shouldn't be blanked from here — only write a non-empty change.
    if (this.canEditName() && name && name !== this.name().trim()) {
      writes.push(this.settings.setName(roomId, name));
    }
    if (this.canEditTopic() && topic !== this.topic().trim()) {
      writes.push(this.settings.setTopic(roomId, topic));
    }
    if (writes.length === 0) {
      this.dialogRef.close(false);
      return;
    }
    this.saving.set(true);
    forkJoin(writes)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.dialogRef.close(true),
        error: () => {
          this.saving.set(false);
          this.toast.show('Could not save room settings.', {
            duration: 4000,
            variant: 'destructive',
          });
        },
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
