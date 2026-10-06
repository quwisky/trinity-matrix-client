import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';

const APP_NAME = 'Trinity';

interface TitleBarContext {
  readonly title: string;
  readonly quickSwitcher: () => void;
}

/** The title row text for the open room; DMs and rooms without a space drop the prefix. */
export function roomTitle(
  space: string | null,
  room: { name: string; isDirect: boolean } | null,
): string {
  if (!room) return APP_NAME;
  const name = room.isDirect ? room.name : `#${room.name}`;
  return space && !room.isDirect ? `${space} · ${name}` : name;
}

/** What the desktop title row and the browser tab show; the open room publishes it. */
@Injectable({ providedIn: 'root' })
export class TitleBarState {
  private readonly context = signal<TitleBarContext | null>(null);
  private readonly activeState = signal(false);

  readonly title = computed(() => this.context()?.title ?? APP_NAME);
  readonly quickSwitcher = computed(
    () => this.context()?.quickSwitcher ?? null,
  );

  /** True while the desktop title row renders; the Rooms sidebar then drops its switcher. */
  readonly active = this.activeState.asReadonly();

  constructor() {
    const pageTitle = inject(Title);
    effect(() => {
      const title = this.title();
      // No room open: the row says "Trinity", and the tab must not repeat it.
      pageTitle.setTitle(
        title === APP_NAME ? APP_NAME : `${title} – ${APP_NAME}`,
      );
    });
  }

  setActive(active: boolean): void {
    this.activeState.set(active);
  }

  setContext(context: TitleBarContext | null): void {
    this.context.set(context);
  }
}
