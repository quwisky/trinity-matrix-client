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
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
} from '@trinity/components/overlay';
import { SaveFailureComponent } from './save-failure/save-failure.component';

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
    SaveFailureComponent,
    TrnButton,
    TrnSwitchComponent,
    TrnSettingsGroupComponent,
    TrnSettingsRowComponent,
  ],
})
export class SystemTitleBarBlockComponent {
  private readonly titleBar = getTrinityDesktopBridge()?.capabilities.titleBar;
  private readonly state = signal<{ saved: boolean; active: boolean } | null>(
    null,
  );
  private readonly saving = signal(false);

  protected readonly supported = !!this.titleBar;
  protected readonly loaded = computed(() => this.state() !== null);
  protected readonly saved = computed(() => this.state()?.saved ?? false);
  // The window reads the preference at launch, so any difference is a change saved during
  // this session, also after Settings was closed and reopened.
  protected readonly needsRestart = computed(() => {
    const state = this.state();
    return !this.saving() && !!state && state.saved !== state.active;
  });
  protected readonly failed = signal(false);

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
    if (!this.titleBar || !previous || this.saving()) return;
    this.saving.set(true);
    this.failed.set(false);
    this.state.set({ ...previous, saved: value });
    let completed = false;
    try {
      completed =
        (await this.titleBar.setSystemTitleBar(value)).kind === 'completed';
    } catch {
      completed = false;
    }
    this.saving.set(false);
    if (!completed) {
      this.state.set(previous);
      this.failed.set(true);
    }
  }

  protected restart(): void {
    this.titleBar?.relaunch();
  }
}
