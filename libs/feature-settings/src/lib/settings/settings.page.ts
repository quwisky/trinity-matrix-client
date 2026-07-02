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
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import {
  HlmRadio,
  HlmRadioGroup,
  HlmRadioIndicator,
} from '@trinity/ui-spartan';
import { AvatarComponent, runWithBusy } from '@trinity/ui';
import {
  ProfileService,
  ThemeService,
  type ThemePreference,
} from '@trinity/core';
import { DevicesSectionComponent } from '../devices/devices-section.component';

/**
 * Settings shell hosting Profile (display name + avatar) and Appearance
 * (light/dark/system theme). Device management lands here in a later M9 increment.
 */
@Component({
  selector: 'trn-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
  imports: [
    AvatarComponent,
    DevicesSectionComponent,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonInput,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    IonTitle,
    IonToolbar,
    HlmRadioGroup,
    HlmRadio,
    HlmRadioIndicator,
  ],
})
export class SettingsPage {
  readonly theme = inject(ThemeService);
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

  /** Apply + persist the chosen appearance when the radio group changes. */
  onThemeChange(value: string): void {
    this.theme.setPreference(value as ThemePreference);
  }

  onNameInput(event: Event): void {
    this.nameDraft.set(
      (event as CustomEvent<{ value: string | null }>).detail.value ?? '',
    );
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
