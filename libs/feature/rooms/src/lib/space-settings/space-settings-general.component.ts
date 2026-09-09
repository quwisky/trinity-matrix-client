import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { FormField, FormRoot } from '@angular/forms/signals';
import {
  TrnActionAvailability,
  TrnButton,
  TrnInput,
  TrnTextarea,
} from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { initialOf } from '@trinity/util/matrix';
import { AvatarFieldComponent } from '../shared/avatar-field/avatar-field.component';
import { SettingsIdentityCardComponent } from '../shared/settings-identity-card/settings-identity-card.component';
import { SpaceSettingsDraftService } from './space-settings-draft.service';

/** Space profile editor backed by the hub's exact Account-and-Space lifetime. */
@Component({
  selector: 'trn-space-settings-general',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarFieldComponent,
    SettingsIdentityCardComponent,
    FormField,
    FormRoot,
    TrnActionAvailability,
    TrnButton,
    TrnInput,
    TrnTextarea,
    TrnTooltip,
  ],
  templateUrl: './space-settings-general.component.html',
  styleUrl: './space-settings-general.component.scss',
})
export class SpaceSettingsGeneralComponent {
  readonly accountId = input.required<string>();
  readonly spaceId = input.required<string>();
  readonly spaceDisplayName = input('Space');
  readonly draft = inject(SpaceSettingsDraftService);

  readonly spaceInitial = computed(() =>
    initialOf(this.draft.model().name || this.spaceDisplayName()),
  );
}
