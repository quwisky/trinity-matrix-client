import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TrnButton, TrnSwitchComponent } from '@trinity/components/controls';
import { getTrinityDesktopBridge } from '@trinity/platform-native';
import { SettingsToggleRowDirective } from '../shared/settings-toggle-row.directive';
import { SettingsGroupComponent } from '../shared/settings-group/settings-group.component';

/**
 * Desktop-only choice between Trinity's title row and the operating system's window frame.
 * The host stores it and applies it on the next launch, so the toggle shows the saved value
 * and a Restart prompt appears while the saved value differs from the running window.
 */
@Component({
  selector: 'trn-system-title-bar-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './system-title-bar-block.component.html',
  imports: [
    TrnButton,
    TrnSwitchComponent,
    SettingsToggleRowDirective,
    SettingsGroupComponent,
  ],
})
export class SystemTitleBarBlockComponent {
  private readonly titleBar = getTrinityDesktopBridge()?.capabilities.titleBar;
  private readonly state = signal<{ saved: boolean; active: boolean } | null>(
    null,
  );
  /** Set once a save completed, so a stale mismatch never prompts before the user acts. */
  private readonly saveCompleted = signal(false);

  protected readonly supported = !!this.titleBar;
  protected readonly loaded = computed(() => this.state() !== null);
  protected readonly saved = computed(() => this.state()?.saved ?? false);
  protected readonly needsRestart = computed(() => {
    const state = this.state();
    return this.saveCompleted() && !!state && state.saved !== state.active;
  });
  protected readonly failed = signal(false);
  /**
   * Bumped on a failed save. The native checkbox already flipped, and re-binding the same
   * `checked` value would not reset it, so the switch is recreated to show the saved value.
   */
  protected readonly switchEpoch = signal(0);

  constructor() {
    const destroyRef = inject(DestroyRef);
    let destroyed = false;
    destroyRef.onDestroy(() => (destroyed = true));
    this.titleBar
      ?.getSystemTitleBar()
      .then((state) => !destroyed && this.state.set(state))
      // An unanswerable host leaves the setting hidden rather than guessing.
      .catch(() => undefined);
  }

  protected async onChange(value: boolean): Promise<void> {
    const previous = this.state();
    if (!this.titleBar || !previous) return;
    this.failed.set(false);
    this.state.set({ ...previous, saved: value });
    let completed = false;
    try {
      completed =
        (await this.titleBar.setSystemTitleBar(value)).kind === 'completed';
    } catch {
      completed = false;
    }
    if (completed) {
      this.saveCompleted.set(true);
    } else {
      this.state.set(previous);
      this.failed.set(true);
      this.switchEpoch.update((n) => n + 1);
    }
  }

  protected restart(): void {
    this.titleBar?.relaunch();
  }
}
