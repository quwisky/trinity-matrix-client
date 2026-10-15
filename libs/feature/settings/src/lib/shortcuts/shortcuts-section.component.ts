import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { AppLockService } from '@trinity/data-access/app-lock';
import {
  KeyboardShortcutsService,
  chordFromEvent,
  formatChord,
  hasModifier,
  isBrowserReserved,
  type ShortcutView,
} from '@trinity/platform-native';
import { filter } from 'rxjs';
import {
  TrnAlertService,
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnToastService,
} from '@trinity/components/overlay';

/** A shortcut row plus the presentational bits the template needs. */
interface ShortcutRow extends ShortcutView {
  /** Key-cap labels for the current binding, or [] when unset/fixed. */
  caps: string[];
  /** The line under the description, if any. */
  hint: string | undefined;
}

/** One `category` heading and the shortcuts filed under it. */
interface ShortcutGroup {
  category: string;
  rows: ShortcutRow[];
}

/**
 * Keyboard-shortcuts settings: lists every shortcut with its binding (the discoverability
 * surface), lets the user rebind one by capturing a chord, and resets — per row or all at
 * once. Bindings live in {@link KeyboardShortcutsService}; this is the view over it.
 */
@Component({
  selector: 'trn-shortcuts-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shortcuts-section.component.html',
  imports: [TrnSettingsRowComponent, TrnSettingsGroupComponent, TrnButton],
  host: {
    class: 'block',
    // Active only while capturing (guarded inside the handler), so it never intercepts
    // ordinary keys. `window` so a chord is caught wherever focus sits in the section.
    '(window:keydown)': 'onCapture($event)',
  },
})
export class ShortcutsSectionComponent {
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly appLock = inject(AppLockService);
  private readonly destroyRef = inject(DestroyRef);
  /** Ends this section's hold on every shortcut; set only while a row captures. */
  private releaseCapture: (() => void) | null = null;

  /** The shortcut currently in capture (edit) mode, or null. */
  readonly capturingId = signal<string | null>(null);

  /** Lock Trinity is named after the running app ("Lock Trinity Next" in the prerelease). */
  readonly rows = computed<ShortcutRow[]>(() => {
    const lockOn = this.appLock.enabled();
    return this.shortcuts.list().map((view) => {
      const lockNow = view.id === 'lock.now';
      return {
        ...view,
        description: lockNow
          ? `Lock ${this.appLock.appName}`
          : view.description,
        caps: view.chord ? formatChord(view.chord) : [],
        hint:
          lockNow && !lockOn
            ? 'Available when App lock is on'
            : view.desktopOnly
              ? 'Desktop app only'
              : view.desktopAlias
                ? 'Also Ctrl+Tab in the desktop app'
                : undefined,
      };
    });
  });

  /**
   * The rows grouped under their category heading, in catalogue order — which is the order
   * `SHORTCUTS` documents itself as rendering in, so a group appears where its first shortcut
   * does and the rows inside it keep their relative order.
   *
   * The list is otherwise flat, which was fine while every shortcut was navigation; it stops
   * being fine once the composer's formatting chords sit in the same catalogue.
   */
  readonly groups = computed<ShortcutGroup[]>(() => {
    // Lock Trinity is listed only where App lock can be on (not on the web).
    const lockOffered = this.appLock.enabled() || this.appLock.offered();
    const byCategory = new Map<string, ShortcutRow[]>();
    for (const row of this.rows()) {
      if (row.id === 'lock.now' && !lockOffered) {
        continue;
      }
      const rows = byCategory.get(row.category);
      if (rows) {
        rows.push(row);
      } else {
        byCategory.set(row.category, [row]);
      }
    }
    return [...byCategory].map(([category, rows]) => ({ category, rows }));
  });

  /**
   * Whether any listed shortcut carries a custom binding (enables "Reset all"). A hidden
   * Lock Trinity binding (imported where App lock can't be on) doesn't count by itself.
   */
  readonly hasCustomBindings = computed(() =>
    this.groups().some((group) => group.rows.some((row) => !row.isDefault)),
  );

  constructor() {
    // Closing Settings mid-capture must not leave every shortcut held.
    this.destroyRef.onDestroy(() => this.setCapturing(null));
  }

  /** Enter capture mode for a rebindable shortcut. */
  edit(row: ShortcutRow): void {
    if (row.rebindable) {
      this.setCapturing(row.id);
    }
  }

  /** Leave capture mode without changing anything. */
  cancelCapture(): void {
    this.setCapturing(null);
  }

  /** Restore one shortcut's default binding. */
  reset(id: string): void {
    this.shortcuts.reset(id);
  }

  /** Restore every shortcut to its default, after a confirm. */
  resetAll(): void {
    this.alert
      .confirm$({
        header: 'Reset shortcuts',
        message: 'Restore every keyboard shortcut to its default binding?',
        confirmText: 'Reset all',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.shortcuts.resetAll());
  }

  /** Capture the next chord while a row is in edit mode and apply it. */
  onCapture(event: Event): void {
    const id = this.capturingId();
    // Locked: keys typed at the lock screen never change a binding behind the cover. The
    // row keeps waiting for a chord once the person unlocks.
    if (!id || this.appLock.locked()) {
      return;
    }
    const e = event as KeyboardEvent;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelCapture();
      return;
    }
    const chord = chordFromEvent(e);
    if (!chord) {
      return; // a lone modifier — keep waiting for the full chord
    }
    e.preventDefault();
    if (!hasModifier(chord)) {
      this.toast.show('Use a modifier — Ctrl, Cmd or Alt.', {
        variant: 'danger',
      });
      return;
    }
    const result = this.shortcuts.rebind(id, chord);
    if (!result.ok) {
      // Keep capturing: the chord was refused, so the row is still waiting for a usable one.
      const holder = this.rows().find(
        (row) => row.id === result.conflict,
      )?.description;
      this.toast.show(`That chord is taken by “${holder}”, which is fixed.`, {
        variant: 'danger',
      });
      return;
    }
    this.setCapturing(null);
    this.announce(chord, result.displaced);
  }

  /** Enter or leave capture mode; while capturing, no shortcut fires anywhere. */
  private setCapturing(id: string | null): void {
    this.capturingId.set(id);
    if (id === null) {
      this.releaseCapture?.();
      this.releaseCapture = null;
    } else {
      this.releaseCapture ??= this.shortcuts.holdForCapture();
    }
  }

  private announce(
    chord: ReturnType<typeof chordFromEvent>,
    displaced: string | null,
  ): void {
    const parts: string[] = [];
    if (displaced) {
      const name = this.rows().find((row) => row.id === displaced)?.description;
      parts.push(`Removed from “${name}” (now unset).`);
    }
    if (chord && isBrowserReserved(chord)) {
      parts.push('This chord only works in the desktop app.');
    }
    if (parts.length) {
      this.toast.show(parts.join(' '));
    }
  }
}
