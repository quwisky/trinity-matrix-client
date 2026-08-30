import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnLabel } from '@trinity/components/controls';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';
import {
  GIF_PROVIDERS,
  GifSettingsService,
  isGifProviderId,
  type GifProviderId,
} from '@trinity/data-access/gif';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading.component';

/**
 * GIF-picker settings: choose a provider (KLIPY / GIPHY) and paste its API key.
 * Until a key is saved the composer hides its GIF button. The key is low-
 * sensitivity third-party config, persisted in Preferences by GifSettingsService.
 */
@Component({
  selector: 'trn-gifs-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './gifs-section.component.html',
  host: { class: 'block' },
  imports: [
    TitleCasePipe,
    TrnButton,
    TrnInput,
    TrnLabel,
    TrnRadioGroupComponent,
    SettingsSectionHeadingComponent,
  ],
})
export class GifsSectionComponent {
  private readonly settings = inject(GifSettingsService);

  readonly providers = GIF_PROVIDERS;
  /** The same providers, in the shape the radio group takes. */
  readonly providerOptions: readonly TrnRadioOption<GifProviderId>[] =
    GIF_PROVIDERS.map((provider) => ({
      value: provider.id,
      label: provider.label,
      testId: `gif-provider-${provider.id}`,
    }));
  readonly configured = this.settings.configured;

  /**
   * The retired provider this device was moved off at startup, or null. Shown so the empty
   * key box reads as "your old provider is gone" rather than "your key vanished" — the
   * migration clears the key deliberately, because a key for a shut-down API cannot work
   * against its replacement.
   */
  readonly migratedFrom = this.settings.migratedFrom;

  /** Local draft of the provider choice (committed on Save). */
  readonly provider = signal<GifProviderId>(this.settings.provider());
  /** Local draft of the API key (committed on Save). */
  readonly apiKeyDraft = signal(this.settings.apiKey());

  /** Metadata (label + key-help link) for the currently selected provider. */
  readonly selected = computed(
    () =>
      this.providers.find((p) => p.id === this.provider()) ?? this.providers[0],
  );

  /** The form has a key and differs from what's saved — enables Save. */
  readonly dirty = computed(
    () =>
      this.apiKeyDraft().trim().length > 0 &&
      (this.provider() !== this.settings.provider() ||
        this.apiKeyDraft().trim() !== this.settings.apiKey()),
  );

  onProviderChange(value: string): void {
    if (isGifProviderId(value)) {
      this.provider.set(value);
    }
  }

  onKeyInput(event: Event): void {
    this.apiKeyDraft.set((event.target as HTMLInputElement).value);
  }

  save(): void {
    this.settings.save(this.provider(), this.apiKeyDraft());
  }

  clear(): void {
    this.settings.clear();
    this.apiKeyDraft.set('');
  }
}
