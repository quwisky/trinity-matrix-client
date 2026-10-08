import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  signal,
  viewChild,
  inject,
} from '@angular/core';
import { WorkspaceBackService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import {
  AvatarComponent,
  TrnSpinnerComponent,
} from '@trinity/components/generic-content';
import {
  TrnDialogRef,
  TrnSettingsLayoutComponent,
  TrnSurfaceService,
  type TrnSettingsLayoutSection,
} from '@trinity/components/overlay';
import { textScaledViewportSignal } from '@trinity/util/ui';
import type { CapabilityRecoveryOutcome } from '@trinity/runtime/projection';
import { of, take } from 'rxjs';
import { ApplicationRuntimeService } from '../../application-runtime.service';
import {
  CapabilityStatusService,
  type CapabilityStatusEntry,
} from '../../capability-status.service';
import { ApplicationRecoveryPresenter } from '../application-recovery.presenter';

/** Capability health and recovery, opened by the application root as a modal surface. */
@Component({
  selector: 'trn-system-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    TrnButton,
    TrnSettingsLayoutComponent,
    TrnSpinnerComponent,
  ],
  templateUrl: './system-status.component.html',
  styleUrl: './system-status.component.scss',
})
export class SystemStatusComponent {
  private readonly ref = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly runtime = inject(ApplicationRuntimeService);
  private readonly startupRecovery = inject(ApplicationRecoveryPresenter);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly layout = viewChild(TrnSettingsLayoutComponent);

  readonly status = inject(CapabilityStatusService);
  readonly wide = textScaledViewportSignal(48, this.destroyRef);
  readonly selectedSection = signal<string | null>('overview');
  readonly sections = computed<readonly TrnSettingsLayoutSection[]>(() => [
    { id: 'overview', label: 'Overview', icon: 'list', group: 'Status' },
    ...this.status.groups().map(({ capability }) => ({
      id: capability,
      label: capability,
      icon: 'shield-alert' as const,
      group: 'Needs attention',
    })),
    { id: 'support', label: 'Support details', icon: 'code', group: 'Support' },
  ]);
  /** The open section's name heads the content; the shell header already names the dialog. */
  readonly heading = computed(
    () =>
      this.sections().find(({ id }) => id === this.selectedSection())?.label ??
      null,
  );
  readonly displayedGroups = computed(() =>
    this.status
      .groups()
      .filter(
        ({ capability }) =>
          this.selectedSection() === 'overview' ||
          this.selectedSection() === capability,
      ),
  );

  constructor() {
    // On a sheet or small screen, Back steps from a section to the list first; with the list
    // showing nothing is registered, and the host's Back closes the surface.
    const unregister = inject(WorkspaceBackService).register({
      surface: () => {
        const section = this.selectedSection();
        return !this.wide() && section !== null
          ? {
              layer: 'application',
              surface: { kind: 'system-status', section },
            }
          : null;
      },
      dismiss: () => {
        this.back();
        return of('dismissed' as const);
      },
      ownsTopmostOverlay: () => this.surfaces.isTopmost(this.ref),
    });
    this.destroyRef.onDestroy(unregister);
    effect(() => {
      const selected = this.selectedSection();
      if (
        (selected === null && this.wide()) ||
        (selected !== null &&
          !this.sections().some(({ id }) => id === selected))
      ) {
        this.selectSection('overview');
      }
    });
  }

  protected selectSection(id: string): void {
    this.selectedSection.set(id);
    afterNextRender(
      () => {
        // A recovery confirmation over this surface keeps its focus.
        if (this.surfaces.isTopmost(this.ref)) {
          this.layout()?.focusSectionHeading();
        }
      },
      { injector: this.injector },
    );
  }

  protected back(): void {
    const selected = this.selectedSection();
    if (!this.wide() && selected) {
      this.selectedSection.set(null);
      afterNextRender(() => this.layout()?.focusSectionLink(selected), {
        injector: this.injector,
      });
      return;
    }
    this.close();
  }

  protected close(): void {
    this.ref.close();
  }

  protected retry(entry: CapabilityStatusEntry): void {
    this.status.retry(entry);
  }

  protected recoverStartup(): void {
    const state = this.runtime.state();
    if (state.phase !== 'blocked') return;
    this.startupRecovery
      .confirmAndRecover(state.failure.recovery)
      .pipe(take(1))
      .subscribe((outcome) => this.startupRecovery.present(outcome));
  }

  protected recoveryMessage(
    outcome: CapabilityRecoveryOutcome | null,
  ): string | null {
    switch (outcome?.kind) {
      case 'pending':
        return 'Recovery is in progress. Reopening this view follows the same attempt.';
      case 'success':
        return 'Recovery completed.';
      case 'unavailable':
        return 'Recovery is no longer available for this scope.';
      case 'transition-in-progress':
        return 'Another account transition is in progress. Try again after it settles.';
      case 'timeout':
        return 'Recovery is still unresolved after its observation window. It was not cancelled.';
      case 'failure':
        return 'Recovery settled without restoring this capability.';
      case 'partial':
        return 'Recovery completed partially. Remaining work is shown here.';
      case 'uncertain':
        return 'Recovery ownership is uncertain. Restart Trinity before trying again.';
      default:
        return null;
    }
  }
}
