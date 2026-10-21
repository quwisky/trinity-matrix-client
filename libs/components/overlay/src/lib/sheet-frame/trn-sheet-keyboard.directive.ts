import {
  DOCUMENT,
  DestroyRef,
  Directive,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';

/**
 * The smallest covered height read as a keyboard, in px. Below it the gap is browser chrome:
 * iOS Safari's collapsing toolbar and rubber-band scrolling open gaps of tens of px with no
 * keyboard, and the smallest phone keyboards are well over this.
 */
export const SHEET_KEYBOARD_MIN_HEIGHT = 120;

/** Whether `element` takes typed text, which is the only time a keyboard can be ours. */
function isEditable(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) {
    return !element.readOnly && !element.disabled;
  }
  if (element instanceof HTMLInputElement) {
    const nonText = [
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ];
    return (
      !nonText.includes(element.type) && !element.readOnly && !element.disabled
    );
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/** The parts of the (Chromium-only) VirtualKeyboard API this reads. */
interface VirtualKeyboardLike extends EventTarget {
  readonly boundingRect: { readonly height: number };
}

/**
 * Keeps a bottom sheet clear of the on-screen keyboard.
 *
 * A sheet is pinned to the bottom of the layout viewport, and the keyboard covers that bottom
 * without resizing it: iOS Safari and its WebView overlay the keyboard, and Chromium on Android
 * resizes only the visual viewport by default. So while a keyboard is open this lifts the sheet
 * by the covered height (`translate`, which composes with the entrance animation's and the
 * drag's `transform`), caps it to the visible height, and scrolls the focused field back into
 * view inside its scrolling body.
 *
 * The keyboard height is read from `visualViewport` (the layout viewport's height less the
 * visible one and its offset), and from `navigator.virtualKeyboard` where Chromium reports
 * it. A gap counts as a keyboard only when it is at least {@link SHEET_KEYBOARD_MIN_HEIGHT}
 * and an editable element inside this sheet has focus; anything else (browser chrome, a
 * pinch zoom, a keyboard some other field raised) binds nothing, and neither does any gap while
 * the iOS shell publishes `--trinity-keyboard-inset`: the overlay wrapper and the sheet's height
 * cap follow that inset in CSS, so a lift here would count the keyboard twice. The focused field is
 * scrolled into view once per change of the covered height, not on every viewport scroll,
 * so scrolling inside the sheet is not snapped back.
 *
 * A host directive of `TrnSheetFrameComponent`, so every sheet gets it.
 */
@Directive({
  selector: '[trnSheetKeyboard]',
  host: {
    '[style.translate]': 'lift()',
    '[style.max-height]': 'maxHeight()',
    // Focus moving in or out of a field changes whether a keyboard is this sheet's.
    '(focusin)': 'update()',
    '(focusout)': 'update()',
  },
})
export class TrnSheetKeyboardAvoidance {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  /** Height of the layout viewport the keyboard covers, in px; 0 with no keyboard. */
  private readonly covered = signal(0);
  /** Height of the visible area while a keyboard is open, in px. */
  private readonly visible = signal(0);

  protected readonly lift = computed(() =>
    this.covered() > 0 ? `0 ${-this.covered()}px` : null,
  );
  protected readonly maxHeight = computed(() =>
    this.covered() > 0
      ? `calc(${this.visible()}px - env(safe-area-inset-top, 0px) - var(--trinity-title-row-inset, 0px))`
      : null,
  );

  /** Re-measures; bound by the constructor once the viewport sources are known. */
  protected update: () => void = () => undefined;

  constructor() {
    const win = this.document.defaultView;
    const viewport = win?.visualViewport ?? null;
    const keyboard =
      (win?.navigator as { virtualKeyboard?: VirtualKeyboardLike } | undefined)
        ?.virtualKeyboard ?? null;
    if (!win || (!viewport && !keyboard)) {
      return;
    }
    this.update = () => {
      const zoomed = (viewport?.scale ?? 1) > 1.01;
      const fromViewport = viewport
        ? win.innerHeight - (viewport.height + viewport.offsetTop)
        : 0;
      const fromKeyboard = keyboard?.boundingRect.height ?? 0;
      const gap = Math.round(Math.max(fromViewport, fromKeyboard));
      const typing = this.host.contains(this.document.activeElement)
        ? isEditable(this.document.activeElement)
        : false;
      // The iOS shell publishes the keyboard here and the overlay layer already ends above it.
      const shellHandled =
        parseFloat(
          win
            .getComputedStyle(this.document.documentElement)
            .getPropertyValue('--trinity-keyboard-inset'),
        ) > 0;
      const covered =
        !zoomed && !shellHandled && typing && gap >= SHEET_KEYBOARD_MIN_HEIGHT
          ? gap
          : 0;
      this.visible.set(
        Math.round(viewport?.height ?? win.innerHeight - fromKeyboard),
      );
      const changed = covered !== this.covered();
      this.covered.set(covered);
      if (changed && covered > 0) {
        afterNextRender(() => this.revealFocus(), { injector: this.injector });
      }
    };
    const update = (): void => this.update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    keyboard?.addEventListener('geometrychange', update);
    inject(DestroyRef).onDestroy(() => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      keyboard?.removeEventListener('geometrychange', update);
    });
    this.update();
  }

  /** The field being typed into stays visible inside the sheet's scrolling body. */
  private revealFocus(): void {
    const focused = this.document.activeElement;
    if (focused instanceof HTMLElement && this.host.contains(focused)) {
      focused.scrollIntoView?.({ block: 'nearest' });
    }
  }
}
