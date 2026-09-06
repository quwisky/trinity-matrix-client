import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  signal,
  viewChild,
  inject,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  AvatarComponent,
  TrnSpinnerComponent,
} from '@trinity/components/generic-content';
import {
  TrnDialogService,
  TrnSettingsLayoutComponent,
  type TrnSettingsLayoutSection,
} from '@trinity/components/overlay';
import { textScaledViewportSignal } from '@trinity/util/ui';
import { isMobileOs } from '@trinity/platform-native';
import type { CapabilityRecoveryOutcome } from '@trinity/runtime/projection';
import { take } from 'rxjs';
import { SystemStatusVisibilityService } from '../../system-status-visibility.service';
import { ApplicationRuntimeService } from '../../application-runtime.service';
import {
  CapabilityStatusService,
  type CapabilityStatusEntry,
} from '../../capability-status.service';
import { ApplicationRecoveryPresenter } from '../application-recovery.presenter';

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
  host: {
    '[class.system-status--mobile]': 'mobile',
    '(document:keydown)': 'keydown($event)',
  },
})
export class SystemStatusComponent implements AfterViewInit {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dialog = inject(TrnDialogService);
  private readonly runtime = inject(ApplicationRuntimeService);
  private readonly startupRecovery = inject(ApplicationRecoveryPresenter);

  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly layout = viewChild(TrnSettingsLayoutComponent);

  readonly status = inject(CapabilityStatusService);
  readonly mobile = isMobileOs();
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
    this.destroyRef.onDestroy(
      inject(SystemStatusVisibilityService).registerBackHandler(() =>
        this.back(),
      ),
    );
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

  ngAfterViewInit(): void {
    this.host.nativeElement.querySelector<HTMLElement>('h1')?.focus();
  }

  protected selectSection(id: string): void {
    this.selectedSection.set(id);
    afterNextRender(
      () => {
        if (!this.dialog.hasOpen()) this.layout()?.focusSectionHeading();
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
    this.status.close();
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || this.dialog.hasOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.status.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    const beforeFirst =
      active &&
      first.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING;
    const afterLast =
      active &&
      last.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (event.shiftKey && (active === first || beforeFirst)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || afterLast)) {
      event.preventDefault();
      first.focus();
    }
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
        return 'Another Account transition is in progress. Try again after it settles.';
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
