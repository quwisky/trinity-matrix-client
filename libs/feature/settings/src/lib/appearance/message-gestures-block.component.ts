import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/controls';
import {
  MessageGestureSettingsService,
  isSwipeAction,
} from '@trinity/platform-native';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
} from '@trinity/components/overlay';

/**
 * How a touch gesture acts on a message, as its own block on the Appearance page.
 *
 * Not an appearance axis (nothing here reaches the token layer), so it is grouped apart.
 */
@Component({
  selector: 'trn-message-gestures-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-gestures-block.component.html',
  imports: [
    TrnSelectComponent,
    TrnSettingsGroupComponent,
    TrnSettingsRowComponent,
  ],
})
export class MessageGesturesBlockComponent {
  readonly gestures = inject(MessageGestureSettingsService);

  /**
   * The choices, in the shape the wrapper takes. A stable field, not an inline arrow: the
   * wrapper takes `options` as an input, so a fresh array each pass would re-render the list.
   */
  readonly swipeOptions: readonly TrnSelectOption<string>[] =
    this.gestures.swipeActions.map((action) => ({
      value: action.id,
      label: action.label,
      testId: `message-swipe-${action.id}`,
    }));

  /**
   * Apply + persist which way a message is dragged. Call `isSwipeAction` directly with the
   * `valueChange` value, no cast: narrowing a massaged expression type-checks under vitest
   * but fails in the Angular build.
   */
  onMessageSwipeChange(value: string | null | undefined): void {
    if (isSwipeAction(value)) {
      this.gestures.setMessageSwipe(value);
    }
  }
}
