import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  effect,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { TRN_LOCKABLE_CONTROL, TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnAnchoredOverlayDirective } from '@trinity/components/overlay';

let nextId = 0;

/**
 * Wraps a field or select that can be disabled and, while it is, draws a lock that says why.
 * A small (`sm`) field reports no reason, so it keeps only its dashed look.
 */
@Component({
  selector: 'trn-field-lock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnAnchoredOverlayDirective, TrnButton, TrnIconComponent],
  host: {
    class:
      'relative block data-[locked]:[&_:is(input,textarea):disabled]:pe-12',
    '[attr.data-locked]': 'reason() === null ? null : ""',
  },
  template: `
    <ng-content />
    @if (reason(); as reason) {
      <button
        trnBtn
        presentation="ghost"
        shape="icon"
        size="sm"
        type="button"
        class="absolute end-0.5 top-1/2 -translate-y-1/2 data-[multiline]:top-0.5 data-[multiline]:translate-y-0 pointer-coarse:size-10"
        [attr.data-multiline]="multiline() ? '' : null"
        aria-label="Why is this locked?"
        [attr.aria-describedby]="descriptionId"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="open() ? bubbleId : null"
        (click)="open.set(!open())"
        (keydown.escape)="close($event)"
        (focusout)="open.set(false)"
        data-testid="field-lock"
      >
        <trn-icon name="lock" motion="pop" />
      </button>
      <!-- Out of the name, so the lock never matches the field's label; hidden, so browse mode
           does not read it a second time beside a visible note. The description still reads it. -->
      <span hidden [id]="descriptionId">{{ reason }}</span>
      <ng-template
        [trnAnchoredOverlay]="host"
        [(open)]="open"
        side="top"
        align="end"
      >
        <p
          class="my-1 max-w-60 rounded-[var(--trinity-shape-control-radius)] bg-tooltip px-2.5 py-1.5 text-xs text-tooltip-foreground shadow-overlay"
          [id]="bubbleId"
          data-testid="field-lock-reason"
        >
          {{ reason }}
        </p>
      </ng-template>
    }
  `,
})
export class TrnFieldLockComponent {
  private readonly control = contentChild(TRN_LOCKABLE_CONTROL, {
    descendants: true,
  });
  private readonly id = nextId++;

  /** The bubble sits against the field, not the lock inside it, so it clears the field's edge. */
  protected readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly descriptionId = `trn-field-lock-description-${this.id}`;
  protected readonly bubbleId = `trn-field-lock-reason-${this.id}`;
  protected readonly open = signal(false);
  protected readonly reason = computed(
    () => this.control()?.lockReason() ?? null,
  );
  protected readonly multiline = computed(
    () => this.control()?.multiline ?? false,
  );

  constructor() {
    // A field that unlocks drops its lock; the next lock starts closed.
    effect(() => {
      if (this.reason() === null) this.open.set(false);
    });
  }

  protected close(event: Event): void {
    if (!this.open()) return;
    // Escape closes the reason, not the dialog or sheet the field sits in.
    event.stopPropagation();
    this.open.set(false);
  }
}
