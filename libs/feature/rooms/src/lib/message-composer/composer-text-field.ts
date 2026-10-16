import {
  afterNextRender,
  type ElementRef,
  type Injector,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { type EditResult } from '@trinity/util/matrix';

/**
 * The tallest the input grows before it scrolls.
 *
 * Must stay in agreement with `.composer__input`'s `max-height` in
 * `message-composer.component.scss`. Nothing enforces it but this comment: jsdom reports
 * `scrollHeight: 0` for everything, and the browser tests assert the field's height rather
 * than its ceiling.
 */
const MAX_HEIGHT_PX = 200;

/**
 * The composer's textarea, as everything except the textarea's own markup: caret reads,
 * caret-anchored splices, focus and auto-growing, i.e. writing to a DOM element that Angular
 * also writes to.
 *
 * It deliberately does NOT know about the autocomplete menus or the typing indicator; those
 * are bookkeeping the composer does *around* an edit, and this only lands the edit.
 */
export class ComposerTextField {
  constructor(
    private readonly textarea: Signal<
      ElementRef<HTMLTextAreaElement> | undefined
    >,
    private readonly text: WritableSignal<string>,
    private readonly injector: Injector,
  ) {}

  /** Caret offset in the textarea, or the end of the text when it isn't rendered. */
  caret(): number {
    return this.textarea()?.nativeElement.selectionStart ?? this.text().length;
  }

  /** Put the caret back in the box. */
  focus(): void {
    this.textarea()?.nativeElement.focus();
  }

  /**
   * Adopt an edit's text and selection.
   *
   * The DOM is written synchronously as well as the signal. These edits replace a keystroke we
   * cancelled (Shift+Enter's newline, a formatting chord), so the textarea has to show the
   * result before the *next* keystroke arrives; otherwise a fast typist's next character is read
   * off a stale value and the edit is silently undone. The selection is re-asserted in a
   * microtask as well, because Angular's own `[value]` write lands in there and setting `value`
   * resets the caret to the end.
   */
  write(result: EditResult): void {
    this.text.set(result.text);
    const el = this.textarea()?.nativeElement;
    if (el) {
      el.value = result.text;
      el.setSelectionRange(result.selectionStart, result.selectionEnd);
    }
    this.autoGrow();
    queueMicrotask(() => {
      const settled = this.textarea()?.nativeElement;
      settled?.focus();
      settled?.setSelectionRange(result.selectionStart, result.selectionEnd);
      this.autoGrow();
    });
  }

  /** Replace text[start, end) with `insert`, then restore focus and the caret. */
  replaceRange(start: number, end: number, insert: string): void {
    const value = this.text();
    this.text.set(value.slice(0, start) + insert + value.slice(end));
    queueMicrotask(() => {
      const el = this.textarea()?.nativeElement;
      const pos = start + insert.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
      this.autoGrow();
    });
  }

  /** Re-measure the input against its current content. */
  autoGrow(): void {
    const el = this.textarea()?.nativeElement;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    // A wrapping room-name placeholder is not draft content. Keep an empty input at rows=1.
    if (el.value.length > 0) {
      el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    }
  }

  /**
   * Re-measure the input once the DOM reflects the signals just written.
   *
   * `afterNextRender`, NOT `queueMicrotask`: the app is zoneless, so a signal write only
   * schedules change detection (a rAF/timeout race) and a microtask beats it. After leaving the
   * preview, a microtask measures a textarea still `display: none`, `scrollHeight` reads 0, and
   * the input is pinned to `height: 0px` (it has `min-height: 0` and `box-sizing: border-box`)
   * until the next keystroke. Not reachable by a unit test: jsdom reports `scrollHeight: 0`.
   */
  regrowAfterRender(): void {
    afterNextRender(() => this.autoGrow(), { injector: this.injector });
  }

  /**
   * Focus the input once the DOM reflects the signals just written.
   *
   * Same rAF-vs-microtask reason as {@link regrowAfterRender}: a microtask runs while the
   * textarea is still `display: none`, and `focus()` on a hidden element is a no-op, leaving the
   * caret on `<body>` so the next keystroke goes nowhere.
   */
  focusAfterRender(): void {
    afterNextRender(() => this.focus(), { injector: this.injector });
  }

  /**
   * Keep the highlighted option in view: `aria-activedescendant` doesn't auto-scroll the
   * listbox, and the result set can overflow the menu's max-height. `id` must be the one
   * `ComposerSuggestionsComponent` stamps on the option.
   */
  scrollSuggestionIntoView(id: string): void {
    queueMicrotask(() =>
      document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' }),
    );
  }
}
