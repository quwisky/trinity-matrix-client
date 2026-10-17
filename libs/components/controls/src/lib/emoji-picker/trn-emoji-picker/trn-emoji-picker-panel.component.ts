import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import type { EmojiEvent } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { TrnEmojiIndex } from '../trn-emoji-index.service';
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
 * The vendor fills a new user's frequently-used row from sixteen defaults; a longer line
 * reads past them and empties the row. The columns themselves come from the cells' padding.
 */
const MAX_VENDOR_PER_LINE = 16;

/**
 * The vendor `emoji-mart` picker, internal to {@link TrnEmojiPickerComponent}, which loads it
 * through `@defer` to keep the vendor chunk (about 1 MB) out of the initial bundle. It must
 * stay unreachable from the library barrel and from any static import, or the bundler pulls
 * it back in.
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
  private readonly index = inject(TrnEmojiIndex);
  /** Width of the vendor's emoji rows, measured while filling; null until measured. */
  private readonly rowWidth = signal<number | null>(null);
  /** The host had no width to measure when it rendered (it has no layout yet). */
  private readonly unmeasured = signal(false);
  /** A touch screen needs 44px cells; a mouse keeps the vendor's own. Read once, at creation. */
  private readonly coarsePointer =
    globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;

  readonly size = input.required<TrnEmojiPickerSize>();
  readonly autoFocusSearch = input(false);
  /** Fill the host's width instead of the vendor's fixed nine-column width. */
  readonly fill = input(false);
  /** See {@link TrnEmojiPickerComponent.shown}. */
  readonly shown = input(0);
  /** See {@link TrnEmojiPickerComponent.recent}. */
  readonly recent = input<readonly string[] | undefined>(undefined);
  readonly emojiSelect = output<EmojiEvent>();

  private readonly vendor = viewChild(PickerComponent);

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

  /**
   * The vendor's `perLine`. It fills a new user's frequently-used row from it when the grid is
   * created; the columns themselves follow the width through the cells' padding.
   */
  protected readonly perLine = computed(() =>
    Math.min(this.fit()?.perLine ?? FIXED_PER_LINE, MAX_VENDOR_PER_LINE),
  );

  /** Filling, every cell's padding; the vendor's own 6px until a width is measured. */
  protected readonly cellPadding = computed(() => {
    if (!this.fill()) {
      return null;
    }
    return `${this.fit()?.padding ?? VENDOR_CELL_PADDING}px`;
  });

  /**
   * The vendor's `recent`: ids in place of its own per-device row. Undefined, or nothing it
   * can show, keeps that row.
   */
  protected readonly vendorRecent = computed(() => {
    const ids = new Set(
      (this.recent() ?? []).flatMap((native) => this.index.idFor(native) ?? []),
    );
    return ids.size > 0 ? [...ids] : undefined;
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
   * `perLine` once, when it is created, so it must be created with the right one. Given recent
   * emoji, it waits for the index that maps them, for the same reason. Once created it stays,
   * so a later list (the account's first pick) never tears down the open grid.
   */
  protected readonly ready = linkedSignal<boolean, boolean>({
    source: () =>
      (!this.fill() || this.fit() !== null || this.unmeasured()) &&
      (!this.recent()?.length || this.index.loaded()),
    computation: (now, previous) => previous?.value === true || now,
  });

  constructor() {
    void this.index.load();

    const injector = inject(Injector);
    let firstShown = true;
    effect(() => {
      this.shown();
      untracked(() => {
        if (firstShown) {
          firstShown = false;
          return;
        }
        afterNextRender(() => this.refreshVendor(), { injector });
      });
    });

    const destroyRef = inject(DestroyRef);
    // The vendor's rows are the host's width less its scrollbar. The host's width never
    // depends on the columns, so a new column count cannot feed back into the measurement.
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
      // Measured now so the grid is created with its line; a host with no width yet shows
      // the vendor's default line and adopts the measured one when the observer reports.
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

  /** Trinity's accent, passed as the vendor's `color` because it lands in inline styles. */
  protected readonly accent = 'var(--trinity-accent)';

  /**
   * Shown again without being created again: bring the vendor up to date.
   *
   * Its frequently-used row is read from storage only when created, and drawn from a second
   * list derived then too (`emojisToDisplay`), so both are refreshed. The vendor's
   * `enableFrequentEmojiSort` refreshes only the first, and only on its own picks. The row is
   * drawn at once so the vendor can measure it (`updateCategoriesSize` caches where each
   * category starts); `handleScroll` re-reads the position because the grid comes back
   * scrolled to the top while the anchor bar still marks the old category.
   *
   * These vendor members are public but not documented API; the panel's spec pins them
   * against the installed version.
   */
  private refreshVendor(): void {
    const picker = this.vendor();
    if (!picker) {
      return;
    }
    const recent = picker.categoryRefs.find(
      (category) => category.name === 'Recent',
    );
    if (recent) {
      recent.updateRecentEmojis();
      recent.emojisToDisplay = [...(recent.emojis ?? [])];
      recent.ref.detectChanges();
    }
    picker.updateCategoriesSize();
    picker.handleScroll();
  }
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
