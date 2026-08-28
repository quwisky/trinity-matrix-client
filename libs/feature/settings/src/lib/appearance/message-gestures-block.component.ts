import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/select';
import {
  MessageGestureSettingsService,
  isSwipeAction,
} from '@trinity/platform-native';
import { SettingsFieldRowDirective } from '../shared/settings-field-row.directive';
import { SettingsGroupComponent } from '../shared/settings-group/settings-group.component';

/**
 * How a touch gesture acts on a message, as its own block on the Appearance page.
 *
 * Split out rather than appended, for the reason the code block beside it was: the page's
 * template was already at the size this repo refactors at (`.agents/rules/code-quality.md`).
 * It is also not an appearance axis — nothing here reaches the token layer — so grouping it
 * separately is what stops it reading as one.
 */
@Component({
  selector: 'trn-message-gestures-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './message-gestures-block.component.html',
  imports: [
    TrnSelectComponent,
    SettingsFieldRowDirective,
    SettingsGroupComponent,
  ],
})
export class MessageGesturesBlockComponent {
  readonly gestures = inject(MessageGestureSettingsService);

  /**
   * The choices, in the shape the wrapper takes. A stable field rather than an inline arrow,
   * which would be a new reference every change detection — the wrapper takes `options` as
   * an input, so a fresh array each pass would re-render the list.
   */
  readonly swipeOptions: readonly TrnSelectOption<string>[] =
    this.gestures.swipeActions.map((action) => ({
      value: action.id,
      label: action.label,
      testId: `message-swipe-${action.id}`,
    }));

  /**
   * Apply + persist which way a message is dragged.
   *
   * The guard is called directly, with no cast: `isSwipeAction` takes
   * `string | null | undefined`, which is exactly what `valueChange` gives — narrowing a
   * massaged expression instead would type-check under vitest and fail in the Angular build.
   */
  onMessageSwipeChange(value: string | null | undefined): void {
    if (isSwipeAction(value)) {
      this.gestures.setMessageSwipe(value);
    }
  }
}
