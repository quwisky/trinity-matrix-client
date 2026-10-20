import { NgTemplateOutlet } from '@angular/common';
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
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnEmojiPickerComponent,
  TrnTabsImports,
  type TrnEmojiPick,
} from '@trinity/components/controls';
import {
  TrnAnchoredOverlayDirective,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import { type GifResult } from '@trinity/data-access/gif';
import {
  PERSONAL_IMAGE_PACK_ID,
  RecentEmojiService,
  type ImagePack,
  type ImagePackImage,
} from '@trinity/data-access/media';
import {
  COMPOSER_EXPRESSION_TABS,
  ComposerExpressionTabPreference,
  type ComposerExpressionTab,
} from '@trinity/data-access/timeline';
import { GifPickerComponent } from '../gif-picker/gif-picker.component';
import { AddImagesTileComponent } from '../shared/add-images-tile/add-images-tile.component';
import { AddToMyEmojiService } from '../shared/add-to-my-emoji.service';
import { StickerImageComponent } from '../sticker-image/sticker-image.component';
import { StickerPickerComponent } from '../sticker-picker/sticker-picker.component';

const TAB_LABELS: Readonly<Record<ComposerExpressionTab, string>> = {
  gif: 'GIFs',
  sticker: 'Stickers',
  emoji: 'Emoji',
};

/**
 * The composer's one panel for GIFs, stickers and emoji, each on its own tab.
 *
 * One surface: as a popover it draws one overlay card (tabs as header, the active picker
 * inside with no card of its own); in a bottom sheet the sheet is the only surface.
 *
 * Only usable tabs are offered; with Emoji alone there is no tab bar. The tabs use MANUAL
 * activation: the GIF and sticker pickers move focus into their search field when they
 * appear, so automatic activation would take it off the tab row.
 *
 * The composer owns whether it is open and what each pick does; the panel owns which tab
 * shows, remembered per device through {@link ComposerExpressionTabPreference}.
 */
@Component({
  selector: 'trn-expression-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AddImagesTileComponent,
    GifPickerComponent,
    NgTemplateOutlet,
    StickerImageComponent,
    StickerPickerComponent,
    TrnEmojiPickerComponent,
    TrnOverlaySurfaceDirective,
    TrnTabsImports,
  ],
  templateUrl: './expression-picker.component.html',
  host: {
    class: 'flex flex-col items-stretch',
    // Popover: the emoji picker's 302px in rem, so it follows the text size and stays one
    // width across tabs, clamped to the viewport less the overlay's 8px margins. Sheet:
    // full width.
    '[style.width]':
      "presentation() === 'sheet' ? '100%' : 'calc(302rem / 16)'",
    '[style.max-width]':
      "presentation() === 'sheet' ? null : 'calc(100vw - 1rem)'",
    '[attr.data-presentation]': 'presentation()',
    '[attr.id]': 'panelId()',
    'data-testid': 'expression-picker',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class ExpressionPickerComponent {
  private readonly remembered = inject(ComposerExpressionTabPreference);
  private readonly recentEmoji = inject(RecentEmojiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly content =
    viewChild.required<ElementRef<HTMLElement>>('content');
  private readonly gifPicker = viewChild(GifPickerComponent);
  private readonly stickerPicker = viewChild(StickerPickerComponent);
  /**
   * The anchored layer holding the panel, when it is one. It keeps the panel between opens,
   * so a reopen does not create it again; a sheet has no such layer.
   */
  private readonly layer = inject(TrnAnchoredOverlayDirective, {
    optional: true,
  });
  /**
   * The tab chosen since the panel was last shown; null until one is. Cleared on each show,
   * so a kept panel opens on the remembered tab even if the phone's sheet chose another.
   */
  private readonly chosen = signal<ComposerExpressionTab | null>(null);

  protected readonly labels = TAB_LABELS;
  /** Whether "Your emoji" and its Add tile are offered. */
  protected readonly adding = inject(AddToMyEmojiService).available;
  protected readonly recent = this.recentEmoji.recent;
  /** How many times the panel has been shown; see {@link TrnAnchoredOverlayDirective.shown}. */
  protected readonly shown = computed(() => this.layer?.shown() ?? 0);

  /** Element id, so the composer's trigger can point `aria-controls` at the panel. */
  readonly panelId = input.required<string>();
  /** Whether a GIF provider and API key are configured. */
  readonly gifEnabled = input(false);
  /** Whether the room has at least one sticker-capable pack entry. */
  readonly stickerEnabled = input(false);
  readonly stickerPacks = input<readonly ImagePack[]>([]);
  /** A chosen GIF is being fetched. */
  readonly gifBusy = input(false);
  /** Anchored above the composer, or filling a bottom sheet on a phone or narrow screen. */
  readonly presentation = input<'popover' | 'sheet'>('popover');

  readonly emojiPick = output<TrnEmojiPick>();
  readonly gifSelect = output<GifResult>();
  readonly stickerSelect = output<ImagePackImage>();
  readonly manage = output<void>();
  /** Escape inside the anchored panel, or the sticker picker's own dismiss. */
  readonly dismiss = output<void>();

  /** The personal pack's emoji, from the room's packs (the personal pack is listed first). */
  protected readonly yourEmoji = computed(
    () =>
      this.stickerPacks()
        .find((pack) => pack.id === PERSONAL_IMAGE_PACK_ID)
        ?.images.filter((image) => image.usage.includes('emoticon')) ?? [],
  );

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

  /**
   * One side inset for the tab row and every tab's content, so the selected tab and the
   * search line up: the sheet's 12px, and 8px inside the desktop card.
   */
  protected readonly inset = computed(() =>
    this.presentation() === 'sheet'
      ? 'var(--trinity-space-4)'
      : 'var(--trinity-space-3)',
  );

  constructor() {
    this.recentEmoji.run().pipe(takeUntilDestroyed()).subscribe();

    // Shown again without being created again: redo what creation did (the GIF and sticker
    // pickers focus their search; the emoji grid refreshes its frequently-used row).
    const injector = inject(Injector);
    let firstShown = true;
    effect(() => {
      this.shown();
      untracked(() => {
        if (firstShown) {
          firstShown = false;
          return;
        }
        this.chosen.set(null);
        afterNextRender(
          () => {
            this.gifPicker()?.focusSearch();
            this.stickerPicker()?.focusSearch();
          },
          { injector },
        );
      });
    });

    // A sheet opens with focus on its content, unless focus is already inside. Not the
    // dialog's own autofocus: it runs later and would pull focus out of a search field a
    // picker has already focused (the emoji grid does once its chunk loads).
    afterNextRender(() => {
      const content = this.content().nativeElement;
      if (
        this.presentation() === 'sheet' &&
        !content.contains(content.ownerDocument.activeElement)
      ) {
        content.focus();
      }
    });
  }

  /** A tab chosen in the row; the value is always one of {@link tabs}. */
  protected onTabChange(value: string | undefined): void {
    const tab = this.tabs().find((candidate) => candidate === value);
    if (!tab) {
      return;
    }
    this.chosen.set(tab);
    this.remembered
      .remember(tab)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected onEmojiPick(pick: TrnEmojiPick): void {
    this.recentEmoji.record(pick.native);
    this.emojiPick.emit(pick);
  }

  /** Inserted as `:shortcode:`, which the send path turns into the inline image. Not recent. */
  protected onYourEmojiPick({ shortcode }: ImagePackImage): void {
    const code = `:${shortcode}:`;
    this.emojiPick.emit({ id: shortcode, native: code, colons: code });
  }

  protected onEscape(event: Event): void {
    // A sheet is a dialog, which closes itself on Escape and restores focus to the trigger.
    if (this.presentation() === 'sheet') {
      return;
    }
    event.preventDefault();
    this.dismiss.emit();
  }
}
