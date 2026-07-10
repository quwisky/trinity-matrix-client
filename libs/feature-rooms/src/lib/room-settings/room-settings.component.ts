import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { type Observable, forkJoin } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { RoomSettingsService } from '@trinity/data-access-rooms';

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
  imports: [ReactiveFormsModule, HlmButton, HlmInput],
  templateUrl: './room-settings.component.html',
  styleUrl: './room-settings.component.scss',
})
export class RoomSettingsComponent implements OnInit {
  readonly roomId = input.required<string>();
  readonly name = input('');
  readonly topic = input('');
  readonly canEditName = input(false);
  readonly canEditTopic = input(false);

  private readonly dialogRef =
    inject<DialogRef<boolean, RoomSettingsComponent>>(DialogRef);
  private readonly settings = inject(RoomSettingsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** True while the save writes are in flight (disables the form + Save). */
  readonly saving = signal(false);

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

  close(): void {
    this.dialogRef.close(false);
  }
}
