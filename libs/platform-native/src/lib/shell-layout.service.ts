import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  combinePreferenceInitialization,
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
  type PreferenceInitializationRead,
} from './preference-initialization';

/**
 * The two pane widths the rooms shell lets you drag, persisted per install.
 *
 * Lives here, not in the rooms feature, because `platform-config-entries.ts` exposes it in
 * the settings JSON editor and a feature lib cannot be imported from this library.
 *
 * Both a drag and a hand-edited config are clamped, once, here: a squeezed navigation column
 * is unusable, and so is a timeline with no room left.
 */

/** Storage keys. Prefixed like every other preference so a wipe can find them. */
const SIDEBAR_KEY = 'trinity.shell.sidebar-width';
const RIGHT_PANEL_KEY = 'trinity.shell.right-panel-width';

/**
 * The rail (72px) plus the room list (280px).
 *
 * Px, not a rem slot like `w-88`: the column's contents are hard-coded px, so a slot that
 * grew with the root font size would leave a gap that widens with text scaling.
 * `text-scaling.spec.mts` asserts the rail and room-list edges meet at every text size.
 */
export const DEFAULT_SIDEBAR_WIDTH = 352;

/** The default width of the right-hand panel slot, in px. */
export const DEFAULT_RIGHT_PANEL_WIDTH = 480;

/**
 * The rail alone is 72px: under ~200 leaves the room list a sliver; past ~560 it crowds
 * the timeline.
 */
export const SIDEBAR_WIDTH_BOUNDS = { min: 200, max: 560 } as const;

/** A thread or search result needs prose width; past ~720 the timeline is squeezed. */
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

  /** Load both widths before the shell first paints, so the default never flashes. */
  async init(): Promise<PreferenceInitializationOutcome> {
    const [sidebar, secondaryPane] = await Promise.all([
      this.read(SIDEBAR_KEY, DEFAULT_SIDEBAR_WIDTH, SIDEBAR_WIDTH_BOUNDS),
      this.read(
        RIGHT_PANEL_KEY,
        DEFAULT_RIGHT_PANEL_WIDTH,
        RIGHT_PANEL_WIDTH_BOUNDS,
      ),
    ]);
    this._sidebarWidth.set(sidebar.value);
    this._rightPanelWidth.set(secondaryPane.value);
    return combinePreferenceInitialization([
      sidebar.outcome,
      secondaryPane.outcome,
    ]);
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

  private async read(
    key: string,
    fallback: number,
    bounds: { min: number; max: number },
  ): Promise<PreferenceInitializationRead<number>> {
    try {
      const { value } = await Preferences.get({ key });
      const parsed = Number(value);
      // `Number(null)` and `Number('')` are 0, so a missing key would clamp to the minimum.
      if (value === null) {
        return { value: fallback, outcome: preferenceInitializationReady };
      }
      if (value !== '' && Number.isFinite(parsed)) {
        return {
          value: clamp(parsed, bounds),
          outcome: preferenceInitializationReady,
        };
      }
      return {
        value: fallback,
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    } catch {
      return {
        value: fallback,
        outcome: preferenceInitializationDefaulted('storage-unavailable'),
      };
    }
  }

  private write(
    key: string,
    target: { set: (value: number) => void },
    value: number,
  ): void {
    target.set(value);
    // Fire and forget: the signal is the session's source of truth. The rejection is handled
    // so best-effort persistence cannot become a global application error.
    void Preferences.set({ key, value: String(value) }).catch(() => undefined);
  }
}
