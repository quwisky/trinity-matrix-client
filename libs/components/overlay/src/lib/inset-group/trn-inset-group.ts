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
 * comes from padding because the touch-target rule fixes min-height at 44px. Padding and gap
 * are 1rem capped at 16px: the largest text size scales the root to 250%, which would take 80px
 * a side and leave the label a few letters. The focused row
 * rises over its neighbours, which would otherwise cover its ring.
 */
@Directive({
  selector: 'button[trnInsetRow], a[trnInsetRow]',
  host: {
    class:
      'relative gap-[min(1rem,16px)] rounded-none px-[min(1rem,16px)] py-4 text-base first:rounded-t-[var(--trinity-radius-xl)] last:rounded-b-[var(--trinity-radius-xl)] focus-visible:z-[1]',
  },
})
export class TrnInsetRow {}

/**
 * The rule between rows. `icon` insets to the label (the row's padding, the 1.5rem icon and
 * gap); `edge` insets by the row padding only. Decorative, so it may vanish under forced
 * colours; the cards' gaps still separate the groups.
 */
@Component({
  selector: 'trn-inset-divider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    class: 'block h-px shrink-0 bg-[color:var(--trinity-border-sheet-divider)]',
    '[class.ms-[calc(min(1rem,16px)*2+1.5rem)]]': "inset() === 'icon'",
    '[class.ms-[min(1rem,16px)]]': "inset() === 'edge'",
  },
})
export class TrnInsetDividerComponent {
  readonly inset = input<'icon' | 'edge'>('icon');
}
