import {
  afterNextRender,
  type ElementRef,
  type Injector,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { isWebKit } from '@trinity/platform-native';
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
 * Replace `el.value[start, end)` with `insert` as a native edit, so the textarea's undo stack
 * keeps it; assigning `value` from script empties that stack in Chromium and Firefox. False when
 * the edit wasn't made (WebKit, an unfocusable field, a nested `execCommand`, jsdom) and the
 * caller must write the value itself.
 */
function splice(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
  insert: string,
): boolean {
  if (start === end && !insert) return true;
  // WebKit merges this edit into the typing run before it, so one undo erases the whole draft.
  if (isWebKit()) return false;
  const expected = el.value.slice(0, start) + insert + el.value.slice(end);
  el.focus();
  if (el.ownerDocument.activeElement !== el) return false;
  el.setSelectionRange(start, end);
  // Optional call: jsdom has no execCommand.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- no supported API lands a script edit on native undo
  el.ownerDocument.execCommand?.(
    insert ? 'insertText' : 'delete',
    false,
    insert,
  );
  return el.value === expected;
}

/** The span of `before` that differs from `after`, and what `after` has there instead. */
function changedRange(
  before: string,
  after: string,
): [start: number, end: number, insert: string] {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before.at(-1 - tail) === after.at(-1 - tail)
  ) {
    tail++;
  }
  return [start, before.length - tail, after.slice(start, after.length - tail)];
}

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
    const el = this.textarea()?.nativeElement;
    if (el) {
      if (!splice(el, ...changedRange(el.value, result.text))) {
        el.value = result.text;
      }
      el.setSelectionRange(result.selectionStart, result.selectionEnd);
    }
    this.text.set(result.text);
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
    const current = this.textarea()?.nativeElement;
    if (current?.value === value) {
      splice(current, start, end, insert);
    }
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
    // A wrapping room-name placeholder is not draft content. Keep an empty input at rows=1.
    if (el.value.length === 0) {
      el.style.height = 'auto';
      return;
    }
    // Hidden (the preview, a `display: none` ancestor): it reads 0, and writing that would show it
    // collapsed. Its padding makes a rendered input's reading positive.
    if (el.scrollHeight === 0) {
      return;
    }
    // Measuring forces a layout with the input collapsed. Were the composer to shrink with it, the
    // browser would clamp the timeline's scrollTop to the taller viewport and lose a bottom pin.
    const box = el.parentElement;
    if (box) box.style.minHeight = `${box.getBoundingClientRect().height}px`;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    if (box) box.style.minHeight = '';
  }

  /**
   * Re-measure the input once the DOM reflects the signals just written.
   *
   * `afterNextRender`, NOT `queueMicrotask`: the app is zoneless, so a signal write only
   * schedules change detection (a rAF/timeout race) and a microtask beats it. After leaving the
   * preview, a microtask finds a textarea still `display: none`, which {@link autoGrow} cannot
   * measure. Not reachable by a unit test: jsdom reports `scrollHeight: 0`.
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
