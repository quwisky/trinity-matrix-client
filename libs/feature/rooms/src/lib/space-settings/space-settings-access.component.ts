import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormField, FormRoot } from '@angular/forms/signals';
import {
  TrnActionAvailability,
  TrnButton,
  TrnSelectComponent,
} from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { SpaceSettingsDraftService } from './space-settings-draft.service';

/** Existing Space join policy, isolated from Room history and restriction creation. */
@Component({
  selector: 'trn-space-settings-access',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    FormRoot,
    TrnActionAvailability,
    TrnButton,
    TrnSelectComponent,
    TrnTooltip,
  ],
  templateUrl: './space-settings-access.component.html',
  styleUrl: './space-settings-access.component.scss',
})
export class SpaceSettingsAccessComponent {
  readonly draft = inject(SpaceSettingsDraftService);
}
