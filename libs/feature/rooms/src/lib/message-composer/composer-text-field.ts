import {
  afterNextRender,
  type ElementRef,
  type Injector,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { type EditResult } from '@trinity/util/matrix';

/**
 * The tallest the input grows before it scrolls. Must stay in agreement with the
 * `max-height` in `message-composer.component.scss`; nothing enforces that but this comment,
 * because jsdom reports `scrollHeight: 0` and cannot see either number.
 */
const MAX_HEIGHT_PX = 200;

/**
 * The composer's textarea, as everything except the textarea's own markup.
 *
 * Caret reads, caret-anchored splices, focus and auto-growing are one job — writing to a DOM
 * element that Angular also writes to — and they are the only reason the component reached
 * for `nativeElement` at all. A plain class rather than an `@Injectable`, for the same reasons
 * the autocomplete engines beside it are: one per composer, no injectable dependency, and
 * constructible in a bare unit test.
 *
 * It deliberately does NOT know about the autocomplete menus or the typing indicator. Those
 * are bookkeeping the composer does *around* an edit; this only lands the edit.
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
   * cancelled — Shift+Enter's newline, a formatting chord — so the textarea has to show the
   * result before the *next* keystroke arrives. Leaving it to change detection opens a window
   * in which a fast typist's next character is read back off a stale value and the edit is
   * silently undone. The selection is re-asserted in a microtask as well, because Angular's own
   * `[value]` write lands somewhere in there and setting `value` resets the caret to the end.
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
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }

  /**
   * Re-measure the input once the DOM reflects the signals just written.
   *
   * `afterNextRender`, NOT `queueMicrotask`: the app is zoneless, so a signal write only
   * schedules change detection (a rAF/timeout race) and a microtask beats it. Leaving the
   * preview is the case that bit — the microtask measured a textarea still `display: none`,
   * `scrollHeight` read 0, and the input was pinned to `height: 0px` (it has `min-height: 0`
   * and `box-sizing: border-box`) until the next keystroke grew it again. Not reachable by a
   * unit test: jsdom reports `scrollHeight: 0` for everything.
   */
  regrowAfterRender(): void {
    afterNextRender(() => this.autoGrow(), { injector: this.injector });
  }

  /**
   * Focus the input once the DOM reflects the signals just written.
   *
   * Same rAF-vs-microtask reason as {@link regrowAfterRender}, with a sharper failure: a
   * microtask runs while the textarea is still `display: none`, and `focus()` on a hidden
   * element is a no-op — the caret ends up on `<body>` and the next keystroke goes nowhere.
   */
  focusAfterRender(): void {
    afterNextRender(() => this.focus(), { injector: this.injector });
  }

  /**
   * Keep the highlighted option in view: `aria-activedescendant` doesn't auto-scroll the
   * listbox, and the result set can overflow the menu's max-height. `id` must be the one
   * `ComposerSuggestionsComponent` stamps on the option — the same id
   * `aria-activedescendant` points at.
   */
  scrollSuggestionIntoView(id: string): void {
    queueMicrotask(() =>
      document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' }),
    );
  }
}
