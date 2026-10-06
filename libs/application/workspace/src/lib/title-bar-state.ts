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

  readonly title = computed(() => this.context()?.title ?? APP_NAME);
  readonly quickSwitcher = computed(
    () => this.context()?.quickSwitcher ?? null,
  );

  constructor() {
    const pageTitle = inject(Title);
    effect(() => {
      const context = this.context();
      pageTitle.setTitle(context ? `${context.title} – ${APP_NAME}` : APP_NAME);
    });
  }

  setContext(context: TitleBarContext | null): void {
    this.context.set(context);
  }
}
