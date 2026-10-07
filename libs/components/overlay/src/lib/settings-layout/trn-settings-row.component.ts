import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A label and description on the inline start with the projected control on the end. */
@Component({
  selector: 'trn-settings-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'settings-row',
    class:
      'flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--trinity-border-subtle)] py-3',
  },
  template: `
    <div class="min-w-0 flex-[1_1_12rem]">
      @if (for()) {
        <label
          [for]="for()"
          [attr.id]="labelId()"
          class="font-semibold text-[var(--trinity-text-bright)]"
          >{{ label() }}</label
        >
      } @else {
        <div
          [attr.id]="labelId()"
          class="font-semibold text-[var(--trinity-text-bright)]"
        >
          {{ label() }}
        </div>
      }
      @if (description()) {
        <p
          [attr.id]="for() ? for() + '-description' : null"
          class="m-0 text-sm text-[var(--trinity-text-muted)]"
        >
          {{ description() }}
        </p>
      }
    </div>
    <div class="ms-auto max-w-full min-w-0"><ng-content /></div>
  `,
})
export class TrnSettingsRowComponent {
  readonly label = input.required<string>();
  readonly description = input<string>();
  readonly for = input<string>();
  /** Id of the label element, for a control that is named by it (`aria-labelledby`). */
  readonly labelId = input<string>();
}
