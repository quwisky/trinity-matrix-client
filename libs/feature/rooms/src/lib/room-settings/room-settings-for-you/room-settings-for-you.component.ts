import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormRoot } from '@angular/forms/signals';
import {
  TrnButton,
  TrnCheckboxComponent,
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';
import type { RoomNotifyMode } from '@trinity/data-access/notifications';
import { RoomSettingsDraftService } from '../room-settings-draft.service';
import { RoomSettingsForYouDraftService } from './room-settings-for-you-draft.service';
import { SettingsLoadStateCardComponent } from '../../shared/settings-load-state-card/settings-load-state-card.component';

const NOTIFICATION_OPTIONS: readonly TrnRadioOption<RoomNotifyMode>[] = [
  {
    value: 'all',
    label: 'All messages',
    testId: 'room-settings-notify-all',
  },
  {
    value: 'mentions',
    label: 'Mentions and keywords',
    testId: 'room-settings-notify-mentions',
  },
  {
    value: 'mute',
    label: 'Mute, including mentions',
    testId: 'room-settings-notify-mute',
  },
];

/** Personal Room preferences for the immutable opening Account. */
@Component({
  selector: 'trn-room-settings-for-you',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormRoot,
    TrnButton,
    TrnCheckboxComponent,
    TrnRadioGroupComponent,
    SettingsLoadStateCardComponent,
  ],
  templateUrl: './room-settings-for-you.component.html',
  styleUrl: './room-settings-for-you.component.scss',
})
export class RoomSettingsForYouComponent {
  readonly room = inject(RoomSettingsDraftService);
  readonly draft = inject(RoomSettingsForYouDraftService);
  readonly notificationOptions = NOTIFICATION_OPTIONS;
}
