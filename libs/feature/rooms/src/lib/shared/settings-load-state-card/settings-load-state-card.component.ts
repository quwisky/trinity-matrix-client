import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';

@Component({
  selector: 'trn-settings-load-state-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  templateUrl: './settings-load-state-card.component.html',
  styleUrl: './settings-load-state-card.component.scss',
})
export class SettingsLoadStateCardComponent {
  readonly state = input.required<'loading' | 'unavailable' | 'failed'>();
  readonly heading = input.required<string>();
  readonly description = input.required<string>();
  readonly failureLayout = input<'flow' | 'grouped'>('flow');
  readonly retryTestid = input<string>();
  readonly retry = output<void>();
}
