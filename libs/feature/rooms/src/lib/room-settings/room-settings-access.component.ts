import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { FormField, FormRoot } from '@angular/forms/signals';
import {
  TrnActionAvailability,
  TrnButton,
  TrnCheckboxComponent,
  TrnSelectComponent,
} from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { RoomSettingsDraftService } from './room-settings-draft.service';
import type { ParentSpace } from './room-settings.models';

/** Access editor backed by the hub's exact-target draft lifetime. */
@Component({
  selector: 'trn-room-settings-access',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    FormRoot,
    TrnActionAvailability,
    TrnButton,
    TrnCheckboxComponent,
    TrnSelectComponent,
    TrnTooltip,
  ],
  templateUrl: './room-settings-access.component.html',
  styleUrl: './room-settings-access.component.scss',
})
export class RoomSettingsAccessComponent {
  readonly parentSpaces = input<readonly ParentSpace[]>([]);
  readonly draft = inject(RoomSettingsDraftService);
}
