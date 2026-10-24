import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { IMAGE_PACK_EDITOR, type PackRef } from '@trinity/data-access/media';
import { EMPTY, defer } from 'rxjs';

/** Room settings › Emoji: the room's own pack, in the grid Settings uses for "Your emoji". */
@Component({
  selector: 'trn-room-settings-emoji',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet],
  template: `
    @if (editor(); as component) {
      <ng-container
        [ngComponentOutlet]="component"
        [ngComponentOutletInputs]="inputs()"
      />
    }
  `,
})
export class RoomSettingsEmojiComponent {
  private readonly load = inject(IMAGE_PACK_EDITOR, { optional: true });

  protected readonly editor = toSignal(this.load ? defer(this.load) : EMPTY);
  protected readonly inputs = computed(() => ({
    ref: {
      kind: 'room',
      accountId: this.accountId(),
      roomId: this.roomId(),
    } satisfies PackRef,
    encrypted: this.encrypted(),
  }));

  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly encrypted = input(false);
}
