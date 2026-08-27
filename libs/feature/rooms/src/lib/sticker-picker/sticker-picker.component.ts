import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { StickerImageComponent } from '../sticker-image/sticker-image.component';
import type { ImagePack, ImagePackImage } from '@trinity/data-access/media';

/** Searchable, keyboard-native picker for sticker-capable MSC2545 pack entries. */
@Component({
  selector: 'trn-sticker-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StickerImageComponent],
  templateUrl: './sticker-picker.component.html',
  styleUrl: './sticker-picker.component.scss',
})
export class StickerPickerComponent {
  readonly packs = input<readonly ImagePack[]>([]);
  readonly selected = output<ImagePackImage>();
  protected readonly query = signal('');

  protected readonly visiblePacks = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.packs()
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
      .filter((pack) => pack.images.length > 0);
  });

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
