import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import {
  PERSONAL_IMAGE_PACK_ID as PERSONAL,
  type ImagePack,
  type ImagePackImage,
} from '@trinity/data-access/media';
import { AddImagesTileComponent } from '../shared/add-images-tile/add-images-tile.component';
import { AddToMyEmojiService } from '../shared/add-to-my-emoji.service';
import { StickerImageComponent } from '../sticker-image/sticker-image.component';

/**
 * Searchable, keyboard-native picker for sticker-capable MSC2545 pack entries: the Stickers
 * tab of the composer's expression panel, which draws the surface around it. Where images can
 * be added, "Your stickers" comes first, even while empty, ending in an Add tile.
 */
@Component({
  selector: 'trn-sticker-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AddImagesTileComponent, EmptyStateComponent, StickerImageComponent],
  templateUrl: './sticker-picker.component.html',
  styleUrl: './sticker-picker.component.scss',
})
export class StickerPickerComponent {
  private readonly adder = inject(AddToMyEmojiService);
  protected readonly personal = PERSONAL;
  readonly packs = input<readonly ImagePack[]>([]);
  readonly selected = output<ImagePackImage>();
  readonly dismiss = output<void>();
  readonly manage = output<void>();
  protected readonly query = signal('');
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  constructor() {
    afterNextRender(() => this.focusSearch());
  }

  /**
   * Put focus in the search field. The picker does this when it is created; a panel that
   * keeps it between opens calls this on each reopen.
   */
  focusSearch(): void {
    this.search()?.nativeElement.focus();
  }

  protected readonly visiblePacks = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    const adding = this.adder.available();
    const packs = this.packs();
    const own: ImagePack = packs.find((pack) => pack.id === PERSONAL) ?? {
      id: PERSONAL,
      roomId: '',
      stateKey: '',
      name: '',
      attribution: null,
      scope: { emoticon: 'account', sticker: 'account' },
      images: [],
    };
    return (adding ? [own, ...packs.filter((pack) => pack !== own)] : packs)
      .map((pack) => ({
        ...pack,
        images: pack.images.filter(
          (image) =>
            image.usage.includes('sticker') &&
            (!query ||
              image.shortcode.toLocaleLowerCase().includes(query) ||
              image.body.toLocaleLowerCase().includes(query)),
        ),
      }))
      .filter(
        (pack) => pack.images.length > 0 || (adding && pack.id === PERSONAL),
      );
  });

  protected readonly found = computed(() =>
    this.visiblePacks().some((pack) => pack.images.length > 0),
  );

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected labelFor(image: ImagePackImage): string {
    return (
      (image.body.slice(0, 256) || image.shortcode) +
      ' (:' +
      image.shortcode +
      ':)'
    );
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.dismiss.emit();
  }
}
