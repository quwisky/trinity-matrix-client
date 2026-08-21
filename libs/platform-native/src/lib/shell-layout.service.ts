import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

/**
 * The two pane widths the rooms shell lets you drag, persisted per install.
 *
 * Lives here rather than in the rooms feature for the same reason the theme does: it is a
 * preference, `platform-config-entries.ts` has to reach it to expose it in the settings JSON
 * editor, and that file is in this library — a feature lib is below it in the boundary and
 * cannot be imported from here.
 *
 * Bounds are the point of this service, not decoration. The rail plus the room list is a
 * navigation column that stops being navigable when it is squeezed, and a timeline that has
 * given all its room away is unreadable, so a drag is clamped and so is a hand-edited config.
 * The clamps live once, here, and both the handle and the JSON editor go through them.
 */

/** Storage keys. Prefixed like every other preference so a wipe can find them. */
const SIDEBAR_KEY = 'trinity.shell.sidebar-width';
const RIGHT_PANEL_KEY = 'trinity.shell.right-panel-width';

/**
 * The rail (72px) plus the room list (280px), as the shell has always shipped it.
 *
 * `rooms.page.html` carries this same number as `md:w-[352px]` with an eight-line comment
 * explaining why it is px rather than `w-88`, and `text-scaling.spec.mts` asserts the rail
 * and sidebar edges meet at every text size. The default has to keep matching it.
 */
export const DEFAULT_SIDEBAR_WIDTH = 352;

/** The width the side panels had as `md:w-120` dialog cards. */
export const DEFAULT_RIGHT_PANEL_WIDTH = 480;

/**
 * The rail alone is 72px, so anything under ~200 leaves the room list a sliver; past ~560 it
 * is taking space from the conversation, which is what people came for.
 */
export const SIDEBAR_WIDTH_BOUNDS = { min: 200, max: 560 } as const;

/**
 * A thread or a search result needs prose width to be worth reading; past ~720 the timeline
 * beside it is the one being squeezed.
 */
export const RIGHT_PANEL_WIDTH_BOUNDS = { min: 280, max: 720 } as const;

const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, Math.round(value)));

@Injectable({ providedIn: 'root' })
export class ShellLayoutService {
  private readonly _sidebarWidth = signal(DEFAULT_SIDEBAR_WIDTH);
  private readonly _rightPanelWidth = signal(DEFAULT_RIGHT_PANEL_WIDTH);

  /** Width of the rail + room list column, in px. */
  readonly sidebarWidth = this._sidebarWidth.asReadonly();
  /** Width of the right-hand panel slot, in px. */
  readonly rightPanelWidth = this._rightPanelWidth.asReadonly();

  readonly sidebarBounds = SIDEBAR_WIDTH_BOUNDS;
  readonly rightPanelBounds = RIGHT_PANEL_WIDTH_BOUNDS;

  /**
   * Load both widths before the shell first paints.
   *
   * Registered as an app initializer beside the other preference loads, so a dragged layout
   * is the one that renders rather than the default flashing first.
   */
  async init(): Promise<void> {
    this._sidebarWidth.set(
      await this.read(SIDEBAR_KEY, DEFAULT_SIDEBAR_WIDTH, SIDEBAR_WIDTH_BOUNDS),
    );
    this._rightPanelWidth.set(
      await this.read(
        RIGHT_PANEL_KEY,
        DEFAULT_RIGHT_PANEL_WIDTH,
        RIGHT_PANEL_WIDTH_BOUNDS,
      ),
    );
  }

  /** Set and persist the sidebar width, clamped. */
  setSidebarWidth(px: number): void {
    this.write(
      SIDEBAR_KEY,
      this._sidebarWidth,
      clamp(px, SIDEBAR_WIDTH_BOUNDS),
    );
  }

  /** Set and persist the right-panel width, clamped. */
  setRightPanelWidth(px: number): void {
    this.write(
      RIGHT_PANEL_KEY,
      this._rightPanelWidth,
      clamp(px, RIGHT_PANEL_WIDTH_BOUNDS),
    );
  }

  /** Both back to what the shell ships with. */
  reset(): void {
    this.setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    this.setRightPanelWidth(DEFAULT_RIGHT_PANEL_WIDTH);
  }

  private async read(
    key: string,
    fallback: number,
    bounds: { min: number; max: number },
  ): Promise<number> {
    try {
      const { value } = await Preferences.get({ key });
      const parsed = Number(value);
      // `Number(null)` is 0 and `Number('')` is 0, so a missing key would otherwise read as a
      // width of zero and clamp to the minimum — a pane the user never chose.
      return value !== null && value !== '' && Number.isFinite(parsed)
        ? clamp(parsed, bounds)
        : fallback;
    } catch {
      return fallback; // storage unavailable → ship default
    }
  }

  private write(
    key: string,
    target: { set: (value: number) => void },
    value: number,
  ): void {
    target.set(value);
    // Fire and forget, like every other preference here: the signal is the source of truth
    // for this session, and a failed write costs the setting on the next launch, not now.
    void Preferences.set({ key, value: String(value) });
  }
}
