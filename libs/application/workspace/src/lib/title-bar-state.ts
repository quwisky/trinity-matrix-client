import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { injectHostAppName } from '@trinity/runtime/host';

interface TitleBarContext {
  /** The open room's title, or `null` with no room open (the row shows the app name). */
  readonly title: string | null;
  readonly quickSwitcher: () => void;
}

/**
 * The title row text for the open room, or `null` with none open; DMs and rooms without
 * a space drop the prefix.
 */
export function roomTitle(
  space: string | null,
  room: { name: string; isDirect: boolean } | null,
): string | null {
  if (!room) return null;
  const name = room.isDirect ? room.name : `#${room.name}`;
  return space && !room.isDirect ? `${space} · ${name}` : name;
}

/** What the desktop title row and the browser tab show; the open room publishes it. */
@Injectable({ providedIn: 'root' })
export class TitleBarState {
  private readonly context = signal<TitleBarContext | null>(null);
  private readonly activeState = signal(false);
  private readonly lockedState = signal(false);
  /** The open room's title, or null with none open or while App lock is locked. */
  private readonly roomTitle = computed(() =>
    this.lockedState() ? null : (this.context()?.title ?? null),
  );

  /** "Trinity", or "Trinity Next" in the desktop prerelease. */
  readonly appName = injectHostAppName();
  /**
   * Only the app name while App lock is locked: the taskbar, the macOS Window menu and
   * window switchers show the window title.
   */
  readonly title = computed(() => this.roomTitle() ?? this.appName);
  readonly quickSwitcher = computed(
    () => this.context()?.quickSwitcher ?? null,
  );

  /** True while the desktop title row renders; the Rooms sidebar then drops its switcher. */
  readonly active = this.activeState.asReadonly();

  constructor() {
    const pageTitle = inject(Title);
    effect(() => {
      const room = this.roomTitle();
      // No room open: the row shows the app name, and the tab must not repeat it.
      pageTitle.setTitle(
        room === null ? this.appName : `${room} – ${this.appName}`,
      );
    });
  }

  setActive(active: boolean): void {
    this.activeState.set(active);
  }

  setContext(context: TitleBarContext | null): void {
    this.context.set(context);
  }

  setLocked(locked: boolean): void {
    this.lockedState.set(locked);
  }
}
