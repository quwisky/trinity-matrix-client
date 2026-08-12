import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TrnButton } from '@trinity/kit/button';
import { TrnAlertService, TrnToastService } from '@trinity/kit/overlay';
import {
  KeyboardShortcutsService,
  chordFromEvent,
  formatChord,
  hasModifier,
  isBrowserReserved,
  type ShortcutView,
} from '@trinity/platform-native';

/** A shortcut row plus the presentational bits the template needs. */
interface ShortcutRow extends ShortcutView {
  /** Key-cap labels for the current binding, or [] when unset/fixed. */
  caps: string[];
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
  styleUrl: './shortcuts-section.component.scss',
  imports: [TrnButton],
  host: {
    // Active only while capturing (guarded inside the handler), so it never intercepts
    // ordinary keys. `window` so a chord is caught wherever focus sits in the section.
    '(window:keydown)': 'onCapture($event)',
  },
})
export class ShortcutsSectionComponent {
  private readonly shortcuts = inject(KeyboardShortcutsService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);

  /** The shortcut currently in capture (edit) mode, or null. */
  readonly capturingId = signal<string | null>(null);

  readonly rows = computed<ShortcutRow[]>(() =>
    this.shortcuts.list().map((view) => ({
      ...view,
      caps: view.chord ? formatChord(view.chord) : [],
    })),
  );

  /**
   * The rows grouped under their category heading, in catalogue order — which is the order
   * `SHORTCUTS` documents itself as rendering in, so a group appears where its first shortcut
   * does and the rows inside it keep their relative order.
   *
   * The list is otherwise flat, which was fine while every shortcut was navigation; it stops
   * being fine once the composer's formatting chords sit in the same catalogue.
   */
  readonly groups = computed<ShortcutGroup[]>(() => {
    const byCategory = new Map<string, ShortcutRow[]>();
    for (const row of this.rows()) {
      const rows = byCategory.get(row.category);
      if (rows) {
        rows.push(row);
      } else {
        byCategory.set(row.category, [row]);
      }
    }
    return [...byCategory].map(([category, rows]) => ({ category, rows }));
  });

  /** Whether any shortcut carries a custom binding (enables "Reset all"). */
  readonly hasCustomBindings = computed(() =>
    this.rows().some((row) => !row.isDefault),
  );

  /** Enter capture mode for a rebindable shortcut. */
  edit(row: ShortcutRow): void {
    if (row.rebindable) {
      this.capturingId.set(row.id);
    }
  }

  /** Leave capture mode without changing anything. */
  cancelCapture(): void {
    this.capturingId.set(null);
  }

  /** Restore one shortcut's default binding. */
  reset(id: string): void {
    this.shortcuts.reset(id);
  }

  /** Restore every shortcut to its default, after a confirm. */
  async resetAll(): Promise<void> {
    const confirmed = await this.alert.confirm({
      header: 'Reset shortcuts',
      message: 'Restore every keyboard shortcut to its default binding?',
      confirmText: 'Reset all',
    });
    if (confirmed) {
      this.shortcuts.resetAll();
    }
  }

  /** Capture the next chord while a row is in edit mode and apply it. */
  onCapture(event: Event): void {
    const id = this.capturingId();
    if (!id) {
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
        variant: 'destructive',
      });
      return;
    }
    const result = this.shortcuts.rebind(id, chord);
    if (!result.ok) {
      // Keep capturing: the chord was refused, so the row is still waiting for a usable one.
      const holder = this.shortcuts
        .list()
        .find((s) => s.id === result.conflict)?.description;
      this.toast.show(`That chord is taken by “${holder}”, which is fixed.`, {
        variant: 'destructive',
      });
      return;
    }
    this.capturingId.set(null);
    this.announce(chord, result.displaced);
  }

  private announce(
    chord: ReturnType<typeof chordFromEvent>,
    displaced: string | null,
  ): void {
    const parts: string[] = [];
    if (displaced) {
      const name = this.shortcuts
        .list()
        .find((s) => s.id === displaced)?.description;
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
