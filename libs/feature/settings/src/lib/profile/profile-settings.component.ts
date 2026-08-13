import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import { HlmTooltip } from '@trinity/helm/tooltip';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { AvatarComponent, runWithBusy } from '@trinity/ui';
import { ProfileService } from '@trinity/data-access/profile';
import { TrnIconComponent } from '@trinity/components/icon';

/** Profile settings sub-page: avatar (with a corner change badge) + display name. */
@Component({
  selector: 'trn-profile-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-settings.component.html',
  imports: [
    AvatarComponent,
    TrnIconComponent,
    HlmButton,
    HlmTooltip,
    HlmInput,
    HlmLabel,
  ],
})
export class ProfileSettingsComponent {
  private readonly profileSvc = inject(ProfileService);
  private readonly destroyRef = inject(DestroyRef);

  readonly profile = this.profileSvc.profile;
  readonly nameDraft = signal('');
  readonly loading = signal(false);
  readonly savingName = signal(false);
  readonly savingAvatar = signal(false);
  readonly error = signal<string | null>(null);

  /** Whether the draft name differs from the saved one (enables Save). */
  readonly nameDirty = computed(
    () => this.nameDraft().trim() !== (this.profile()?.displayName ?? ''),
  );

  /** Fallback-avatar initial from the display name (or user id when unnamed). */
  readonly initial = computed(() => {
    const p = this.profile();
    const name = (p?.displayName || p?.userId || '').replace(/^[@#!]+/, '');
    return name.charAt(0).toUpperCase() || '?';
  });

  private readonly avatarInput =
    viewChild<ElementRef<HTMLInputElement>>('avatarInput');

  constructor() {
    // Load the profile on open; seed the editable name from the result.
    runWithBusy(this.profileSvc.load(), {
      busy: this.loading,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe((profile) => this.nameDraft.set(profile.displayName));
  }

  onNameInput(event: Event): void {
    this.nameDraft.set((event.target as HTMLInputElement).value);
  }

  saveName(): void {
    runWithBusy(this.profileSvc.setDisplayName(this.nameDraft()), {
      busy: this.savingName,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  /** Open the hidden file input to choose a new avatar. */
  pickAvatar(): void {
    this.avatarInput()?.nativeElement.click();
  }

  onAvatarPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (!file) {
      return;
    }
    // accept="image/*" is only a picker hint — validate before uploading.
    if (!file.type.startsWith('image/')) {
      this.error.set('Please choose an image file.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      this.error.set('That image is too large (max 8 MB).');
      return;
    }
    runWithBusy(this.profileSvc.setAvatar(file), {
      busy: this.savingAvatar,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe();
  }
}

/** Reject avatar uploads larger than this (before hitting a server 413). */
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
