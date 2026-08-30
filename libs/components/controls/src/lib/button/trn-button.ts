import {
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { HlmButton } from '@trinity/helm/button';

/**
 * Trinity's public button directive.
 *
 * Feature code owns the semantic element and asks for Trinity's button treatment with
 * `trnBtn`. Variant and size are the supported styling surface; native button semantics
 * (including `disabled`) remain owned by the host element. The Helm directive
 * remains behind this boundary so a substrate change does not touch feature templates.
 */
@Directive({
  selector: 'button[trnBtn], a[trnBtn]',
  exportAs: 'trnBtn',
  host: {
    '[attr.data-trn-icon-button]': "iconButton() ? '' : null",
  },
  hostDirectives: [
    {
      directive: HlmButton,
      inputs: ['variant', 'size'],
      outputs: [],
    },
  ],
})
export class TrnButton {
  private readonly helm = inject(HlmButton, { self: true });

  /**
   * Icon sizes opt into Trinity's shared icon-button interaction contract.
   *
   * Keep this derived from Helm's public input instead of reading the host attribute: bound
   * sizes need to update reactively, and the public wrapper is the layer that owns the marker.
   */
  protected readonly iconButton = computed(() =>
    this.helm.size()?.startsWith('icon'),
  );
}

/**
 * Keeps an unavailable action discoverable without letting it activate.
 *
 * Native disabled buttons cannot receive focus or pointer events, so their explanatory
 * tooltip is unreachable. This directive uses the ARIA disabled contract instead, exposes
 * the reason to assistive technology, and blocks pointer plus Enter/Space activation in the
 * capture phase. Arrow keys remain untouched so unavailable dropdown items stay in the
 * menu's normal roving-focus order.
 */
@Directive({
  selector: '[trnActionAllowed]',
  host: {
    '[attr.aria-disabled]': 'trnActionAllowed() ? null : "true"',
    '[attr.aria-description]':
      'trnActionAllowed() ? null : trnActionDisabledReason()',
    '[attr.data-trn-action-disabled]': 'trnActionAllowed() ? null : ""',
  },
})
export class TrnActionAvailability {
  readonly trnActionAllowed = input(true);
  readonly trnActionDisabledReason = input<string | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private feedback: HTMLElement | null = null;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const element = this.host.nativeElement;
    const blockClick = (event: Event): void => this.block(event);
    const blockActivationKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        this.block(event);
      }
    };
    const explainTouch = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' && !this.trnActionAllowed()) {
        this.showTouchReason();
      }
    };
    const explainTouchFallback = (): void => {
      if (!this.trnActionAllowed()) {
        this.showTouchReason();
      }
    };
    element.addEventListener('click', blockClick, true);
    element.addEventListener('keydown', blockActivationKey, true);
    element.addEventListener('pointerup', explainTouch, true);
    element.addEventListener('touchend', explainTouchFallback, true);
    this.destroyRef.onDestroy(() => {
      element.removeEventListener('click', blockClick, true);
      element.removeEventListener('keydown', blockActivationKey, true);
      element.removeEventListener('pointerup', explainTouch, true);
      element.removeEventListener('touchend', explainTouchFallback, true);
      this.clearTouchReason();
    });
  }

  private block(event: Event): void {
    if (this.trnActionAllowed()) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /** Tooltips deliberately ignore touch, so a blocked tap gets a short visible reason. */
  private showTouchReason(): void {
    const reason = this.trnActionDisabledReason()?.trim();
    if (!reason) {
      return;
    }
    this.document
      .querySelector<HTMLElement>('[data-trn-action-feedback]')
      ?.remove();
    this.clearTouchReason();
    const feedback = this.document.createElement('div');
    feedback.className = 'trn-action-feedback';
    feedback.dataset['trnActionFeedback'] = '';
    feedback.dataset['testid'] = 'action-unavailable-feedback';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    feedback.textContent = reason;
    this.document.body.append(feedback);
    this.feedback = feedback;
    this.feedbackTimer = setTimeout(() => this.clearTouchReason(), 3000);
  }

  private clearTouchReason(): void {
    if (this.feedbackTimer) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
    this.feedback?.remove();
    this.feedback = null;
  }
}

/**
 * Opts a purpose-built icon control into Trinity's shared interaction contract.
 *
 * Use this only when `trnBtn` would replace meaningful component-owned geometry, such as a
 * circular avatar action, server-rail pill, reaction chip or compact message toolbar control.
 */
@Directive({
  selector: 'button[trnIconButton], a[trnIconButton]',
  host: {
    '[attr.data-trn-icon-button]': "''",
  },
})
export class TrnIconButton {}

export const TrnButtonImports = [
  TrnButton,
  TrnIconButton,
  TrnActionAvailability,
] as const;
