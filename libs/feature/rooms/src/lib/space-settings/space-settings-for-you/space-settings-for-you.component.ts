import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormRoot } from '@angular/forms/signals';
import {
  TrnButton,
  TrnRadioGroupComponent,
} from '@trinity/components/controls';
import { SpaceSettingsForYouDraftService } from './space-settings-for-you-draft.service';

@Component({
  selector: 'trn-space-settings-for-you',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormRoot, TrnButton, TrnRadioGroupComponent],
  templateUrl: './space-settings-for-you.component.html',
  styleUrl: './space-settings-for-you.component.scss',
})
export class SpaceSettingsForYouComponent {
  readonly draft = inject(SpaceSettingsForYouDraftService);
}
