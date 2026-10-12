import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnEmojiPickerComponent,
  type TrnEmojiPick,
} from '@trinity/components/controls';
import { type GifResult } from '@trinity/data-access/gif';
import type { ImagePack, ImagePackImage } from '@trinity/data-access/media';
import {
  COMPOSER_EXPRESSION_TABS,
  ComposerExpressionTabPreference,
  type ComposerExpressionTab,
} from '@trinity/data-access/timeline';
import { GifPickerComponent } from '../gif-picker/gif-picker.component';
import { StickerPickerComponent } from '../sticker-picker/sticker-picker.component';

const TAB_LABELS: Readonly<Record<ComposerExpressionTab, string>> = {
  gif: 'GIFs',
  sticker: 'Stickers',
  emoji: 'Emoji',
};

/**
 * The composer's one panel for GIFs, stickers and emoji, each on its own tab and each the
 * existing picker, unchanged.
 *
 * Only the tabs that can be used are offered, and with Emoji alone there is no tab bar at
 * all. The tabs follow the WAI-ARIA tab pattern with MANUAL activation: the arrow keys,
 * Home and End move focus, and Enter, Space or a click selects. Automatic activation would
 * fight the pickers, because the GIF and sticker pickers move focus into their own search
 * field when they appear, which would take it off the tab row after one arrow press.
 *
 * The composer owns whether it is open and what each pick does; the panel owns which tab
 * shows, and remembers it per device through {@link ComposerExpressionTabPreference}.
 */
@Component({
  selector: 'trn-expression-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GifPickerComponent,
    StickerPickerComponent,
    TrnEmojiPickerComponent,
  ],
  templateUrl: './expression-picker.component.html',
  host: {
    // The emoji picker's own fixed width in px (it does not scale with the text size), so
    // switching tabs does not resize the panel; the GIF and sticker surfaces stretch to it.
    class: 'flex w-[302px] max-w-full flex-col items-stretch gap-2',
    '[attr.id]': 'panelId()',
    'data-testid': 'expression-picker',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class ExpressionPickerComponent {
  private readonly remembered = inject(ComposerExpressionTabPreference);
  private readonly destroyRef = inject(DestroyRef);
  private readonly tabButtons =
    viewChildren<ElementRef<HTMLButtonElement>>('tab');
  /** The tab chosen while this panel is open; null until one is. */
  private readonly chosen = signal<ComposerExpressionTab | null>(null);
  /** The tab holding the single tab stop; null means the selected one. */
  private readonly focusTarget = signal<ComposerExpressionTab | null>(null);

  protected readonly labels = TAB_LABELS;

  /** Element id, so the composer's trigger can point `aria-controls` at the panel. */
  readonly panelId = input.required<string>();
  /** Whether a GIF provider and API key are configured. */
  readonly gifEnabled = input(false);
  /** Whether the room has at least one sticker-capable pack entry. */
  readonly stickerEnabled = input(false);
  readonly stickerPacks = input<readonly ImagePack[]>([]);
  /** A chosen GIF is being fetched. */
  readonly gifBusy = input(false);

  readonly emojiPick = output<TrnEmojiPick>();
  readonly gifSelect = output<GifResult>();
  readonly stickerSelect = output<ImagePackImage>();
  readonly manage = output<void>();
  /** Escape inside the panel, or the sticker picker's own dismiss. */
  readonly dismiss = output<void>();

  protected readonly tabs = computed<readonly ComposerExpressionTab[]>(() =>
    COMPOSER_EXPRESSION_TABS.filter((tab) => {
      switch (tab) {
        case 'gif':
          return this.gifEnabled();
        case 'sticker':
          return this.stickerEnabled() && this.stickerPacks().length > 0;
        case 'emoji':
          return true;
      }
    }),
  );

  /** The chosen tab, else the one this device used last, else Emoji when that is gone. */
  protected readonly active = computed<ComposerExpressionTab>(() => {
    const wanted = this.chosen() ?? this.remembered.tab();
    return this.tabs().includes(wanted) ? wanted : 'emoji';
  });

  protected readonly tabStop = computed(() => {
    const target = this.focusTarget();
    return target && this.tabs().includes(target) ? target : this.active();
  });

  protected tabId(tab: ComposerExpressionTab): string {
    return `${this.panelId()}-tab-${tab}`;
  }

  protected tabPanelId(tab: ComposerExpressionTab): string {
    return `${this.panelId()}-tabpanel-${tab}`;
  }

  protected select(tab: ComposerExpressionTab): void {
    this.chosen.set(tab);
    this.focusTarget.set(null);
    this.remembered
      .remember(tab)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected onTabKeydown(event: KeyboardEvent): void {
    const tabs = this.tabs();
    const from = tabs.indexOf(this.tabStop());
    let to: number;
    switch (event.key) {
      case 'ArrowRight':
        to = (from + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        to = (from - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const tab = tabs[to];
    if (!tab) {
      return;
    }
    this.focusTarget.set(tab);
    this.tabButtons()[to]?.nativeElement.focus();
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    this.dismiss.emit();
  }
}
