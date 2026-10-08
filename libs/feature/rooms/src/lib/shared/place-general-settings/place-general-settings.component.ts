import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { FormField, FormRoot } from '@angular/forms/signals';
import {
  TrnActionAvailability,
  TrnButton,
  TrnInput,
  TrnTextarea,
} from '@trinity/components/controls';
import { TrnSettingsGroupComponent } from '@trinity/components/overlay';
import { TrnTooltip } from '@trinity/components/generic-content';
import { initialOf } from '@trinity/util/matrix';
import { AvatarFieldComponent } from '../avatar-field/avatar-field.component';
import { SettingsIdentityCardComponent } from '../settings-identity-card/settings-identity-card.component';
import type { PlaceProfileDraft } from './place-profile-draft';

/**
 * The General profile form of a Room or Space settings dialog. `noun` supplies the wording and
 * the `room-settings-*` / `space-settings-*` testids; projected content (the Room's Encryption
 * group) renders between the details and the actions.
 */
@Component({
  selector: 'trn-place-general-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarFieldComponent,
    SettingsIdentityCardComponent,
    FormField,
    FormRoot,
    TrnActionAvailability,
    TrnButton,
    TrnSettingsGroupComponent,
    TrnInput,
    TrnTextarea,
    TrnTooltip,
  ],
  templateUrl: './place-general-settings.component.html',
  styleUrl: './place-general-settings.component.scss',
})
export class PlaceGeneralSettingsComponent {
  readonly draft = input.required<PlaceProfileDraft>();
  readonly noun = input.required<'Room' | 'Space'>();
  readonly accountId = input.required<string>();
  readonly placeId = input.required<string>();
  readonly displayName = input.required<string>();
  /** Help line under the Name field. */
  readonly hint = input.required<string>();

  protected readonly prefix = computed(
    () => `${this.noun().toLowerCase()}-settings`,
  );
  protected readonly initial = computed(() =>
    initialOf(this.draft().model().name || this.displayName()),
  );
}
