import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import type { EmojiEvent } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import {
  TRN_EMOJI_TOUCH_CELL,
  VENDOR_CELL_PADDING,
  trnEmojiGridFit,
  trnEmojiPickerGlyphSize,
  type TrnEmojiPickerSize,
} from './trn-emoji-picker-recipe';

/** The vendor's own line length, which its fixed width is computed from. */
const FIXED_PER_LINE = 9;

/**
 * The vendor `emoji-mart` picker, and nothing else.
 *
 * Internal to {@link TrnEmojiPickerComponent}, which loads it through `@defer` so the
 * vendor's chunk (about 1 MB) stays out of the initial bundle. It must stay unreachable
 * from the library barrel and from any static import, or the bundler pulls it back in.
 * Theming, ARIA and the pinned vendor inputs are explained on the wrapper and in the
 * template.
 */
@Component({
  selector: 'trn-emoji-picker-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PickerComponent],
  templateUrl: './trn-emoji-picker-panel.component.html',
  host: {
    style: 'display: block',
    '[style.--trn-emoji-cell-padding]': 'cellPadding()',
  },
})
export class TrnEmojiPickerPanelComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Width of the vendor's emoji rows, measured while filling; null until measured. */
  private readonly rowWidth = signal<number | null>(null);
  /** The host had no width to measure when it rendered (it has no layout yet). */
  private readonly unmeasured = signal(false);
  /**
   * A touch screen needs 44px cells; a mouse keeps the vendor's own. Read once, when the
   * picker opens: a pointer change while it is open keeps the cells it opened with.
   */
  private readonly coarsePointer =
    globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;

  readonly size = input.required<TrnEmojiPickerSize>();
  readonly autoFocusSearch = input(false);
  /** Fill the host's width instead of the vendor's fixed nine-column width. */
  readonly fill = input(false);
  readonly emojiSelect = output<EmojiEvent>();

  /** The glyph the size asks for. */
  private readonly glyph = computed(() => trnEmojiPickerGlyphSize(this.size()));

  /** How the measured row is shared out; null while fixed or not yet measured. */
  private readonly fit = computed(() => {
    const width = this.rowWidth();
    if (!this.fill() || width === null) {
      return null;
    }
    return trnEmojiGridFit(
      width,
      this.glyph(),
      this.coarsePointer ? TRN_EMOJI_TOUCH_CELL : 0,
    );
  });

  /** Filling, the fitted glyph, within a pixel of the size's own. */
  protected readonly vendorEmojiSize = computed(
    () => this.fit()?.glyph ?? this.glyph(),
  );

  protected readonly perLine = computed(
    () => this.fit()?.perLine ?? FIXED_PER_LINE,
  );

  /** Filling, every cell's padding; the vendor's own 6px until a width is measured. */
  protected readonly cellPadding = computed(() => {
    if (!this.fill()) {
      return null;
    }
    return `${this.fit()?.padding ?? VENDOR_CELL_PADDING}px`;
  });

  /**
   * The vendor computes its width from `perLine` unless its `style` names one. Filling, it
   * takes the host's width, and the columns follow from that instead.
   */
  protected readonly vendorStyle = computed(() =>
    this.fill() ? { width: '100%' } : {},
  );

  /**
   * Filling, the vendor waits for the first measurement: it sizes its frequently-used row from
   * `perLine` once, when it is created, so it must be created with the right one.
   */
  protected readonly ready = computed(
    () => !this.fill() || this.fit() !== null || this.unmeasured(),
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    // The vendor's rows are the host's width, less its scrollbar (it takes the host's width
    // and, filling, has no side insets). The host's width never depends on the columns, so a
    // new column count cannot feed back into the measurement. Observed while the picker is
    // open, so a rotation or a resized window recomputes the columns.
    afterNextRender(() => {
      if (!this.fill()) {
        return;
      }
      const host = this.host.nativeElement;
      const gutter = scrollbarGutter(host.ownerDocument);
      const measure = (width: number) => {
        if (width > 0) {
          this.rowWidth.set(width - gutter);
        }
      };
      // Measured once now, so the grid is created with its line. A host with no width yet
      // shows the vendor's default line rather than nothing, and adopts the measured one
      // when the observer reports a width.
      const initial = host.getBoundingClientRect().width;
      if (initial > 0) {
        measure(initial);
      } else {
        this.unmeasured.set(true);
      }
      if (typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver((entries) => {
        const width = entries.at(-1)?.contentRect.width;
        if (width !== undefined) {
          measure(width);
        }
      });
      observer.observe(host);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /**
   * Trinity's accent, handed to the vendor as its own `color`.
   *
   * A token rather than a literal, and passed rather than overridden: the vendor writes
   * this value into inline styles, which a stylesheet cannot outrank without `!important`.
   */
  protected readonly accent = 'var(--trinity-accent)';
}

/**
 * The width a vertical scrollbar takes from the vendor's scroll area: measured the way the
 * vendor measures it, so both agree. Zero where scrollbars overlay the content (touch).
 */
function scrollbarGutter(document: Document): number {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
  document.body.appendChild(probe);
  const gutter = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return gutter;
}
