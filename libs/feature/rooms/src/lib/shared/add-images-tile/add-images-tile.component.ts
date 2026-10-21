import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrackFileChooserDirective } from '@trinity/platform-native';
import { AddToMyEmojiService } from '../add-to-my-emoji.service';

/** A picker's dashed Add tile: chooses images, then adds each to the personal pack. */
@Component({
  selector: 'trn-add-images-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrackFileChooserDirective, TrnIconComponent],
  templateUrl: './add-images-tile.component.html',
  host: { class: 'contents' },
})
export class AddImagesTileComponent {
  private readonly adder = inject(AddToMyEmojiService);

  /** False where a grid's roving focus holds the one Tab stop elsewhere. */
  readonly tabbable = input(true);

  protected onFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) this.adder.addFiles(files);
  }
}
