import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
  signal,
} from '@angular/core';
import { StickerPacksService } from '@trinity/data-access-timeline';
import { type PackImage, type StickerPack } from '@trinity/util-matrix';
import { StickerComponent } from '../sticker/sticker.component';

/** Rendered edge (px) of each sticker thumbnail in the picker grid. */
const THUMB_SIZE = 56;

/**
 * A grid of the user's MSC2545 sticker packs, floated above the composer. Reads the
 * available packs (personal + joined-room packs) when opened and emits the chosen image
 * for the composer to send as an `m.sticker`. Shows a hint when no pack is configured.
 */
@Component({
  selector: 'trn-sticker-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StickerComponent],
  templateUrl: './sticker-picker.component.html',
  styleUrl: './sticker-picker.component.scss',
})
export class StickerPickerComponent {
  /** The user picked a sticker; the composer sends it to the active room. */
  readonly stickerSelect = output<PackImage>();

  readonly thumbSize = THUMB_SIZE;

  private readonly packsService = inject(StickerPacksService);

  /** The packs to show, read once when the picker is created (opened). */
  readonly packs = signal<StickerPack[]>(this.packsService.packs());

  select(image: PackImage): void {
    this.stickerSelect.emit(image);
  }
}
