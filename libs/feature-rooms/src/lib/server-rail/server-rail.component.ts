import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { AvatarComponent } from '../avatar/avatar.component';
import type { SpaceSummary } from '@trinity/core';

/** Discord server rail: Home + one pill per Matrix Space. */
@Component({
  selector: 'app-server-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  template: `
    <nav class="rail">
      <div class="item" [class.active]="activeSpaceId() === null">
        <span class="indicator"></span>
        <button
          class="pill home"
          [class.round]="activeSpaceId() === null"
          (click)="selectSpace.emit(null)"
          aria-label="Home"
          title="Home"
        >
          T
        </button>
      </div>

      <div class="separator"></div>

      @for (space of spaces(); track space.id) {
        <div class="item" [class.active]="activeSpaceId() === space.id">
          <span class="indicator"></span>
          <button
            class="pill"
            (click)="selectSpace.emit(space.id)"
            [attr.aria-label]="space.name"
            [title]="space.name"
          >
            <app-avatar
              [url]="space.avatarUrl"
              [initial]="space.initial"
              [name]="space.name"
              [square]="activeSpaceId() !== space.id"
              [size]="48"
            />
          </button>
        </div>
      }

      <div class="item">
        <span class="indicator"></span>
        <button
          class="pill add"
          aria-label="Add a space"
          title="Add a space (coming soon)"
          disabled
        >
          +
        </button>
      </div>
    </nav>
  `,
  styleUrl: './server-rail.component.scss',
})
export class ServerRailComponent {
  readonly spaces = input<SpaceSummary[]>([]);
  readonly activeSpaceId = input<string | null>(null);
  readonly selectSpace = output<string | null>();
}
