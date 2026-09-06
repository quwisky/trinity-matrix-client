import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { TrnToastService } from '@trinity/components/overlay';
import { RoomSettingsService } from '@trinity/data-access/room-administration';
import {
  AvatarComponent,
  type AvatarShape,
} from '@trinity/components/generic-content';

/**
 * Matrix caps an avatar at the homeserver's upload limit; 8 MB is the common Synapse default and
 * is well past what a sensible avatar needs. Checked here rather than letting the upload fail,
 * so the message names the actual problem.
 */
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

/**
 * The avatar row of a settings dialog: the current image, a "Change photo" button, and the
 * upload.
 *
 * Uploads on pick rather than on Save, unlike every other field in those dialogs. That is
 * deliberate and predates this component: an image is picked from a native file dialog, so the
 * user has already made the decision by the time it lands here, and holding the bytes to batch
 * them with a name change buys nothing.
 *
 * Shared by the room and space dialogs, which differ only in wording. `noun` supplies that
 * ("room" / "space"), and `testid` keeps each dialog's own selector so the two are drivable
 * independently — `RoomSettingsService` itself is roomId-generic and needs no variant.
 */
@Component({
  selector: 'trn-avatar-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnButton, TrnActionAvailability, TrnTooltip],
  templateUrl: './avatar-field.component.html',
  styleUrl: './avatar-field.component.scss',
})
export class AvatarFieldComponent {
  private readonly settings = inject(RoomSettingsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The room or space whose avatar this writes. */
  readonly roomId = input.required<string>();
  /** When present, pins the upload and state write to this exact Account. */
  readonly accountId = input<string | null>(null);
  readonly name = input('');
  readonly avatarMxc = input<string | null>(null);
  readonly initial = input('');
  /** Room/space settings default to place geometry; callers may override explicitly. */
  readonly shape = input<AvatarShape>('place');
  /** False hides the button entirely — the image still shows. */
  readonly editable = input(false);
  /** How the surface names itself in a toast: "room" or "space". */
  readonly noun = input('room');
  /** The opening dialog's own testid for the button, so each stays independently drivable. */
  readonly testid = input('avatar-field');

  protected readonly savingAvatar = signal(false);
  protected readonly avatarFeedback = signal<{
    readonly tone: 'pending' | 'success' | 'danger';
    readonly message: string;
  } | null>(null);
  protected readonly unavailableReason = computed(
    () => `Your role cannot change this ${this.noun()}’s photo.`,
  );
  private readonly avatarInput =
    viewChild<ElementRef<HTMLInputElement>>('avatarInput');

  /** Open the hidden file input to choose a new photo. */
  pickAvatar(): void {
    if (!this.editable()) {
      return;
    }
    this.avatarInput()?.nativeElement.click();
  }

  /** Validate + upload the picked image; toast the outcome. */
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
    this.avatarFeedback.set({
      tone: 'pending',
      message: `Uploading ${this.noun()} photo…`,
    });
    const accountId = this.accountId();
    this.settings
      .setAvatar(
        accountId ? { accountId, roomId: this.roomId() } : this.roomId(),
        file,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.savingAvatar.set(false);
          this.avatarFeedback.set({
            tone: 'success',
            message: `${this.capitalisedNoun()} photo updated.`,
          });
          this.toast.show(`${this.capitalisedNoun()} photo updated.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.savingAvatar.set(false);
          const message = `Could not update the ${this.noun()} photo.`;
          this.avatarFeedback.set({ tone: 'danger', message });
          this.showError(message);
        },
      });
  }

  private capitalisedNoun(): string {
    const noun = this.noun();
    return noun.charAt(0).toUpperCase() + noun.slice(1);
  }

  private showError(message: string): void {
    this.avatarFeedback.set({ tone: 'danger', message });
    this.toast.show(message, { duration: 4000, variant: 'danger' });
  }
}
