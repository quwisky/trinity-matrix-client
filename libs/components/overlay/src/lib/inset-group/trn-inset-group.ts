import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  input,
} from '@angular/core';

/** A rounded surface card that holds {@link TrnInsetRow}s; the caller sets its margin. */
@Directive({
  selector: '[trnInsetGroup]',
  host: {
    class:
      'isolate flex flex-col rounded-[var(--trinity-radius-xl)] bg-[color:var(--trinity-neutral-fill-surface)]',
  },
})
export class TrnInsetGroup {}

/**
 * A full-width row inside a {@link TrnInsetGroup}; goes next to `trnBtn shape="row"`. Height
 * comes from padding because the touch-target rule fixes min-height at 44px. The focused row
 * rises over its neighbours, which would otherwise cover its ring.
 */
@Directive({
  selector: 'button[trnInsetRow], a[trnInsetRow]',
  host: {
    class:
      'relative gap-4 rounded-none px-4 py-4 text-base first:rounded-t-[var(--trinity-radius-xl)] last:rounded-b-[var(--trinity-radius-xl)] focus-visible:z-[1]',
  },
})
export class TrnInsetRow {}

/**
 * The rule between rows. `icon` insets to the label (the row's px-4, the 1.5rem icon and
 * gap-4); `edge` insets by the row padding only. Decorative, so it may vanish under forced
 * colours; the cards' gaps still separate the groups.
 */
@Component({
  selector: 'trn-inset-divider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    class: 'block h-px shrink-0 bg-[color:var(--trinity-border-sheet-divider)]',
    '[class.ms-14]': "inset() === 'icon'",
    '[class.ms-4]': "inset() === 'edge'",
  },
})
export class TrnInsetDividerComponent {
  readonly inset = input<'icon' | 'edge'>('icon');
}
