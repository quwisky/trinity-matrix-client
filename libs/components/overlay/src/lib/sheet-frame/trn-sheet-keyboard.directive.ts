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
 * visible one), and from `navigator.virtualKeyboard` where Chromium reports it. A pinch zoom
 * also shrinks the visual viewport, so a zoomed page is left alone.
 *
 * A host directive of `TrnSheetFrameComponent`, so every sheet gets it.
 */
@Directive({
  selector: '[trnSheetKeyboard]',
  host: {
    '[style.translate]': 'lift()',
    '[style.max-height]': 'maxHeight()',
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

  constructor() {
    const win = this.document.defaultView;
    const viewport = win?.visualViewport ?? null;
    const keyboard =
      (win?.navigator as { virtualKeyboard?: VirtualKeyboardLike } | undefined)
        ?.virtualKeyboard ?? null;
    if (!win || (!viewport && !keyboard)) {
      return;
    }
    const update = (): void => {
      const zoomed = (viewport?.scale ?? 1) > 1.01;
      const visibleHeight = viewport?.height ?? win.innerHeight;
      const fromViewport = viewport
        ? win.innerHeight - (viewport.height + viewport.offsetTop)
        : 0;
      const fromKeyboard = keyboard?.boundingRect.height ?? 0;
      const covered = zoomed
        ? 0
        : Math.max(0, Math.round(Math.max(fromViewport, fromKeyboard)));
      this.visible.set(Math.round(visibleHeight));
      this.covered.set(covered);
      if (covered > 0) {
        afterNextRender(() => this.revealFocus(), { injector: this.injector });
      }
    };
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    keyboard?.addEventListener('geometrychange', update);
    inject(DestroyRef).onDestroy(() => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      keyboard?.removeEventListener('geometrychange', update);
    });
    update();
  }

  /** The field being typed into stays visible inside the sheet's scrolling body. */
  private revealFocus(): void {
    const focused = this.document.activeElement;
    if (focused instanceof HTMLElement && this.host.contains(focused)) {
      focused.scrollIntoView?.({ block: 'nearest' });
    }
  }
}
