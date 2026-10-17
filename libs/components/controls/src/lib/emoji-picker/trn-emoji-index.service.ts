import {
  computed,
  DestroyRef,
  Injectable,
  Injector,
  inject,
  signal,
} from '@angular/core';
import type { EmojiSearch } from '@ctrl/ngx-emoji-mart';
import type { EmojiService } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import type { TrnEmojiSuggestion } from './trn-emoji.model';

/** How many completions a `:shortcode` query returns. */
const SUGGESTION_LIMIT = 8;

/**
 * The emoji index behind Trinity's own API, so the `:shortcode` autocomplete never names the
 * vendor. The vendor and its emoji data (most of a megabyte) load on the first lookup, not at
 * startup; until they arrive lookups answer empty and the signal read re-runs the caller.
 */
@Injectable({ providedIn: 'root' })
export class TrnEmojiIndex {
  private readonly injector = inject(Injector);
  private destroyed = false;
  private readonly vendor = signal<{
    search: EmojiSearch;
    emoji: EmojiService;
  } | null>(null);
  private loading: Promise<void> | null = null;
  private ids: Map<string, string> | null = null;

  /** Whether the vendor has loaded, so lookups answer. */
  readonly loaded = computed(() => this.vendor() !== null);

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
  }

  /** Loads the vendor once. Lookups start it themselves; await it to know the index is ready. */
  load(): Promise<void> {
    return (this.loading ??= Promise.all([
      import('@ctrl/ngx-emoji-mart'),
      import('@ctrl/ngx-emoji-mart/ngx-emoji'),
    ]).then(([mart, ngx]) => {
      // The injector can be gone by the time the chunks land (teardown, tests).
      if (this.destroyed) return;
      this.vendor.set({
        search: this.injector.get(mart.EmojiSearch),
        emoji: this.injector.get(ngx.EmojiService),
      });
    }));
  }

  /** Completions for a `:shortcode` fragment, most relevant first. */
  suggest(
    query: string,
    limit = SUGGESTION_LIMIT,
  ): readonly TrnEmojiSuggestion[] {
    const vendor = this.vendor();
    if (!vendor) {
      void this.load();
      return [];
    }
    const found = vendor.search.search(query, undefined, limit) ?? [];
    return found.map((entry) => ({
      id: String(entry.id ?? ''),
      native: String(entry.native ?? ''),
      colons: String(entry.colons ?? ''),
    }));
  }

  /**
   * The character for a shortcode, or null when it names nothing. Null rather than the input
   * echoed back, so an unresolved shortcode never looks resolved.
   */
  nativeFor(shortcode: string): string | null {
    const vendor = this.vendor();
    if (!vendor) {
      void this.load();
      return null;
    }
    const data = vendor.emoji.getData(shortcode);
    if (!data) return null;
    return vendor.emoji.getSanitizedData(data).native ?? null;
  }

  /**
   * The vendor id for an emoji character, or null when it names none. A variation selector or
   * skin tone the vendor's own data lacks is ignored, so another client's spelling still maps.
   */
  idFor(native: string): string | null {
    const vendor = this.vendor();
    if (!vendor) {
      void this.load();
      return null;
    }
    this.ids ??= new Map(
      vendor.emoji.emojis.flatMap((data) => {
        const id = String(data.id ?? '');
        const char = String(data.native ?? '');
        return [
          [char, id],
          [withoutModifiers(char), id],
        ] as const;
      }),
    );
    return (
      this.ids.get(native) ?? this.ids.get(withoutModifiers(native)) ?? null
    );
  }
}

/** Drops variation selector 16 and the skin tone modifiers. */
function withoutModifiers(native: string): string {
  return native.replace(/\uFE0F|[\u{1F3FB}-\u{1F3FF}]/gu, '');
}
