import {
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  WorkspaceBackService,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import {
  TrnAlertService,
  TrnDialogRef,
  TrnDialogService,
} from '@trinity/components/overlay';
import { textScaledViewportSignal } from '@trinity/util/ui';
import { Observable, defer, of, take } from 'rxjs';
import type { SettingsHubSection } from './settings-hub.component';

interface SettingsHubControllerConfig<Section extends string> {
  readonly sections: readonly (SettingsHubSection & {
    readonly value: Section;
  })[];
  readonly noun: 'Room' | 'Space';
  readonly testIdPrefix: 'room-settings' | 'space-settings';
  readonly accountId: () => string;
  readonly targetId: () => string;
  readonly dirty: () => boolean;
  readonly discard: () => void;
}

/** Shared navigation and dismissal mechanics for Room and Space settings hubs. */
export class SettingsHubController<Section extends string> {
  private readonly dialogRef = inject<TrnDialogRef<boolean>>(TrnDialogRef);
  private readonly dialog = inject(TrnDialogService);
  private readonly alert = inject(TrnAlertService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly confirmingDiscard = signal(false);
  private readonly backActive = signal(false);

  private readonly wide = textScaledViewportSignal(48, inject(DestroyRef));
  readonly compactNavigation = computed(() => !this.wide());
  readonly selectedSection;
  readonly directoryVisible = signal(this.compactNavigation());

  constructor(private readonly config: SettingsHubControllerConfig<Section>) {
    this.selectedSection = signal(config.sections[0].value);
    const unregister = inject(WorkspaceBackService).register({
      surface: () =>
        this.backActive()
          ? {
              layer: 'room',
              surface: {
                kind: 'settings',
                accountId: this.config.accountId(),
                roomId: this.config.targetId(),
              },
            }
          : null,
      dismiss: (surface) => this.dismissFromWorkspace(surface),
      ownsTopmostOverlay: () => this.dialog.isTopmost(this.dialogRef),
    });
    inject(DestroyRef).onDestroy(unregister);
  }

  activate(): void {
    this.backActive.set(true);
  }

  selectSection(value: string): void {
    const section = this.config.sections.find(
      (candidate) => candidate.value === value,
    )?.value;
    if (!section) return;
    if (section === this.selectedSection() && !this.directoryVisible()) return;
    this.guardUnsavedNavigation(() => {
      this.selectedSection.set(section);
      this.directoryVisible.set(false);
      this.focusAfterRender(
        `[data-testid="${this.config.testIdPrefix}-section-heading"]`,
      );
    });
  }

  showDirectory(): void {
    this.guardUnsavedNavigation(() => {
      this.directoryVisible.set(true);
      this.focusAfterRender(
        `[data-testid="${this.config.testIdPrefix}-tab-${this.selectedSection()}"]`,
      );
    });
  }

  /** Called synchronously by the dialog stack for Escape, backdrop, and Host Back. */
  requestExternalDismiss(): boolean {
    if (this.compactNavigation() && !this.directoryVisible()) {
      this.showDirectory();
      return false;
    }
    if (!this.config.dirty()) return true;
    this.confirmDiscard(() => this.dialogRef.close(false));
    return false;
  }

  close(): void {
    if (this.config.dirty()) {
      this.confirmDiscard(() => this.dialogRef.close(false));
      return;
    }
    this.dialogRef.close(false);
  }

  private dismissFromWorkspace(
    surface: WorkspaceSurface,
  ): Observable<'dismissed' | 'blocked'> {
    return defer(() => {
      if (
        surface.layer !== 'room' ||
        surface.surface.kind !== 'settings' ||
        surface.surface.accountId !== this.config.accountId() ||
        surface.surface.roomId !== this.config.targetId()
      ) {
        return of('blocked' as const);
      }
      if (!this.requestExternalDismiss()) return of('blocked' as const);
      this.dialogRef.close(false);
      return of('dismissed' as const);
    });
  }

  private guardUnsavedNavigation(navigate: () => void): void {
    if (!this.config.dirty()) {
      navigate();
      return;
    }
    this.confirmDiscard(() => {
      this.config.discard();
      navigate();
    });
  }

  private confirmDiscard(onDiscard: () => void): void {
    if (this.confirmingDiscard()) return;
    this.confirmingDiscard.set(true);
    this.alert
      .confirm$({
        header: `Discard ${this.config.noun} settings changes?`,
        message: `Your unsaved ${this.config.noun} details will be discarded. Changes already saved, including a photo update, stay applied.`,
        confirmText: 'Discard changes',
        cancelText: 'Keep editing',
        variant: 'danger',
        closeOnNavigation: false,
      })
      .pipe(take(1))
      .subscribe((discard) => {
        this.confirmingDiscard.set(false);
        if (discard) onDiscard();
      });
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }
}
