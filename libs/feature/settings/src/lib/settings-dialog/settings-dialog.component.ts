import { DOCUMENT, NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EnvironmentInjector,
  Injector,
  afterNextRender,
  computed,
  createEnvironmentInjector,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  TrnDialogRef,
  TrnSettingsLayoutComponent,
  type TrnSettingsLayoutSection,
} from '@trinity/components/overlay';
import { BUILD_INFO } from '@trinity/platform-native';
import { textScaledViewportSignal } from '@trinity/util/ui';
import { provideConfigEditor } from '../advanced/config-editor-loader';
import {
  SETTINGS_SECTIONS,
  matchingSettingsSections,
  type SettingsSectionDefinition,
} from '../settings-sections';
import { SettingsDirectorySearchComponent } from '../shared/settings-directory-search/settings-directory-search.component';

@Component({
  selector: 'trn-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgComponentOutlet,
    TrnSettingsLayoutComponent,
    SettingsDirectorySearchComponent,
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss',
})
export class SettingsDialogComponent {
  private readonly ref = inject(TrnDialogRef<void>);
  private readonly build = inject(BUILD_INFO);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly environmentInjector = inject(EnvironmentInjector);
  private readonly document = inject(DOCUMENT);
  private readonly layout = viewChild(TrnSettingsLayoutComponent);
  private readonly directorySearch = viewChild(
    SettingsDirectorySearchComponent,
  );
  private appliedInitialSection?: string;

  readonly initialSection = input<string>();
  readonly initialSource = input<string>();
  readonly query = signal('');
  readonly layoutSections = computed<readonly TrnSettingsLayoutSection[]>(() =>
    matchingSettingsSections(this.query()).map(
      ({ path, label, icon, group }) => ({
        id: path,
        label,
        icon,
        group,
      }),
    ),
  );
  readonly buildLabel = `Trinity v${this.build.version} · ${this.build.commit}`;
  readonly wide = textScaledViewportSignal(48, this.destroyRef);
  readonly selectedPath = signal<string | null>(null);
  readonly selectedSection = computed(() =>
    SETTINGS_SECTIONS.find((item) => item.path === this.selectedPath()),
  );
  readonly sectionInputs = computed<Record<string, unknown>>(() =>
    this.selectedPath() === 'stickers' && this.initialSource()
      ? { initialSource: this.initialSource() }
      : this.selectedPath() === 'security' || this.selectedPath() === 'devices'
        ? { inSettingsDialog: true }
        : {},
  );
  readonly advancedInjector = createEnvironmentInjector(
    [provideConfigEditor()],
    this.environmentInjector,
  );

  constructor() {
    this.destroyRef.onDestroy(() => this.advancedInjector.destroy());
    effect(() => {
      const initial = this.initialSection();
      if (
        initial &&
        initial !== this.appliedInitialSection &&
        SETTINGS_SECTIONS.some((item) => item.path === initial)
      ) {
        this.appliedInitialSection = initial;
        this.selectedPath.set(initial);
        return;
      }
      if (this.wide() && this.selectedPath() === null) {
        this.selectedPath.set(SETTINGS_SECTIONS[0].path);
      }
    });
  }

  selectSection(path: string): void {
    this.selectedPath.set(path);
    afterNextRender(() => this.layout()?.focusSectionHeading(), {
      injector: this.injector,
    });
  }

  sectionInjector(section: SettingsSectionDefinition): Injector {
    return section.path === 'advanced'
      ? this.advancedInjector
      : this.environmentInjector;
  }

  goBackOrClose(): void {
    const selected = this.selectedPath();
    if (!this.wide() && selected) {
      this.selectedPath.set(null);
      afterNextRender(
        () => {
          if (this.layoutSections().some(({ id }) => id === selected)) {
            this.layout()?.focusSectionLink(selected);
          } else {
            this.directorySearch()?.focus();
          }
        },
        { injector: this.injector },
      );
      return;
    }
    this.ref.close();
  }

  close(): void {
    this.ref.close();
  }

  /** Clear stale routed focus hooks before a modal section owns focus. */
  clearRouteFocusTargets(): void {
    for (const target of this.document.querySelectorAll<HTMLElement>(
      '[data-route-focus]',
    )) {
      delete target.dataset['routeFocus'];
    }
  }
}
