import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { AvatarComponent } from '@trinity/components/generic-content';
import { type CommonRoom } from '@trinity/data-access/room-library';

/** The member card's Rooms tab: joined rooms shared with the member. */
@Component({
  selector: 'trn-member-rooms-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  templateUrl: './member-rooms-tab.component.html',
})
export class MemberRoomsTabComponent {
  /** Null while unknown. */
  readonly rooms = input.required<readonly CommonRoom[] | null>();
  readonly open = output<CommonRoom>();
}
