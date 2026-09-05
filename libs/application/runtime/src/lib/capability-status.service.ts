import { Injectable, computed, inject, signal } from '@angular/core';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import {
  BUILD_INFO,
  isElectronRenderer,
  isInstalledNativePlatform,
  isNativeIos,
} from '@trinity/platform-native';
import type { CapabilityRecoveryOutcome } from '@trinity/runtime/projection';
import { take } from 'rxjs';
import { ApplicationRuntimeService } from './application-runtime.service';
import type { ApplicationStartupRecovery } from './application-runtime.models';
import {
  APPLICATION_STARTUP_PRODUCERS,
  APPLICATION_STARTUP_STAGES,
  type ApplicationStartupProducer,
  type ApplicationStartupProducerSettlement,
} from './application-runtime.models';
import {
  CapabilityHealthService,
  type ApplicationCapabilityHealth,
} from './capability-health.service';
import {
  capabilityStatusCopy,
  type CapabilityStatusCopy,
} from './capability-status.catalog';
import { SystemStatusVisibilityService } from './system-status-visibility.service';

export interface CapabilityStatusEntry {
  readonly problem: ApplicationCapabilityHealth;
  readonly copy: CapabilityStatusCopy;
  readonly account: {
    readonly id: string;
    readonly name: string;
    readonly avatarMxc: string | null;
    readonly initial: string;
  } | null;
  readonly recovery: CapabilityRecoveryOutcome | null;
}

export interface CapabilityStatusGroup {
  readonly capability: string;
  readonly entries: readonly CapabilityStatusEntry[];
}

export interface StartupStatusEntry {
  readonly producer: ApplicationStartupProducer | 'runtime';
  readonly stage: string;
  readonly heading: string;
  readonly consequence: string;
}

const CAPABILITY_ORDER = [
  'Device integration',
  'Local storage',
  'Settings',
  'Appearance',
  'Accounts',
  'Rooms',
  'Encryption',
  'People',
  'Notifications',
  'Room administration',
  'App icon',
  'Updates',
  'Trinity',
] as const;

/** Application-owned presentation state; no names or Account ids enter diagnostics. */
@Injectable({ providedIn: 'root' })
export class CapabilityStatusService {
  private readonly health = inject(CapabilityHealthService);
  private readonly runtime = inject(ApplicationRuntimeService);
  private readonly identities = inject(AccountIdentitiesService);
  private readonly build = inject(BUILD_INFO);
  private readonly visibility = inject(SystemStatusVisibilityService);
  private readonly dismissed = signal<ReadonlyMap<string, string>>(new Map());
  private readonly copied = signal(false);

  readonly open = this.visibility.open;
  readonly copyConfirmed = this.copied.asReadonly();
  readonly entries = computed(() =>
    this.health.problems().map((problem) => this.entry(problem)),
  );
  readonly visibleEntries = computed(() =>
    this.entries().filter(
      ({ problem, recovery }) =>
        problem.severity === 'blocking' ||
        this.dismissed().get(problem.reference) !==
          occurrenceSignature(problem, recovery),
    ),
  );
  readonly groups = computed(() => {
    const groups = new Map<string, CapabilityStatusEntry[]>();
    for (const entry of this.entries()) {
      const list = groups.get(entry.copy.capability) ?? [];
      list.push(entry);
      groups.set(entry.copy.capability, list);
    }
    return [...groups]
      .map(([capability, entries]) => ({ capability, entries }))
      .sort(
        (a, b) =>
          orderOf(a.capability) - orderOf(b.capability) ||
          a.capability.localeCompare(b.capability),
      );
  });
  readonly startupBlockers = computed<readonly StartupStatusEntry[]>(() => {
    const state = this.runtime.state();
    if (state.phase !== 'blocked') return [];
    const blocked = state.settlements
      .filter((settlement) => settlement.status === 'blocked')
      .sort(startupSettlementOrder);
    return blocked.length > 0
      ? blocked.map(startupStatusEntry)
      : [
          {
            producer: 'runtime',
            stage: state.failure.stage,
            heading: 'Trinity could not finish starting',
            consequence: startupBlockerConsequence(state.failure.recovery),
          },
        ];
  });
  readonly startupRecovery = computed(() => {
    const state = this.runtime.state();
    return state.phase === 'blocked'
      ? startupRecoveryLabel(state.failure.recovery)
      : null;
  });
  readonly actionableCount = computed(
    () =>
      new Set(this.health.problems().map(({ reference }) => reference)).size +
      this.startupBlockers().length,
  );
  readonly hasBlocking = computed(() =>
    this.visibleEntries().some(
      ({ problem }) => problem.severity === 'blocking',
    ),
  );
  readonly recoveryAnnouncement = computed(() => {
    const notice = this.health.recoveryNotice();
    return notice
      ? `${capabilityStatusCopy(notice.fact).capability} recovered.`
      : '';
  });

  show(): void {
    this.copied.set(false);
    this.visibility.show();
  }

  close(): void {
    this.visibility.close();
  }

  dismiss(entry: CapabilityStatusEntry): void {
    if (entry.problem.severity === 'blocking') return;
    this.dismissed.update((dismissed) => {
      const next = new Map(dismissed);
      next.set(
        entry.problem.reference,
        occurrenceSignature(entry.problem, entry.recovery),
      );
      return next;
    });
  }

  retry(entry: CapabilityStatusEntry): void {
    this.health.recover(entry.problem).pipe(take(2)).subscribe();
  }

  supportDetails(): string {
    const state = this.runtime.state();
    const stage =
      state.phase === 'starting' || state.phase === 'blocked'
        ? 'startup'
        : 'session';
    const attempt = 'attempt' in state ? state.attempt : 0;
    return JSON.stringify(
      {
        generatedBy: 'Trinity System Status',
        diagnostics: this.health.diagnostics(
          stage,
          attempt,
          this.build.version,
          platformKind(),
        ),
      },
      null,
      2,
    );
  }

  copySupportDetails(): void {
    const details = this.supportDetails();
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(details)
      .then(() => this.copied.set(true));
  }

  private entry(problem: ApplicationCapabilityHealth): CapabilityStatusEntry {
    const scope = this.health.presentationScope(problem);
    const identity = scope ? this.identities.identityOf(scope.accountId) : null;
    return {
      problem,
      copy: capabilityStatusCopy(problem),
      account: identity
        ? {
            id: identity.userId,
            name: identity.displayName,
            avatarMxc: identity.avatarMxc,
            initial: identity.displayName.trim().charAt(0).toUpperCase() || '?',
          }
        : null,
      recovery:
        this.health.recoveries().get(problem.reference)?.outcome ?? null,
    };
  }
}

function occurrenceSignature(
  problem: ApplicationCapabilityHealth,
  recovery: CapabilityRecoveryOutcome | null,
): string {
  const recoveryEscalation =
    recovery?.kind === 'failure' ||
    recovery?.kind === 'partial' ||
    recovery?.kind === 'timeout' ||
    recovery?.kind === 'uncertain'
      ? recovery.kind
      : 'settled';
  return `${problem.occurrence}:${problem.severity}:${recoveryEscalation}`;
}

function startupBlockerConsequence(
  recovery: ApplicationStartupRecovery,
): string {
  switch (recovery) {
    case 'retry-startup':
      return 'A required startup dependency is unavailable. Routed content stays closed until it is ready.';
    case 'reset-preferences':
      return 'Required preference defaults are unavailable. Resetting affects settings on this device.';
    case 'reauthenticate':
      return 'The required Account session is unavailable. Reauthentication removes its local session first.';
    case 'reset-installation':
      return 'Required local Account data is unavailable. Resetting erases Trinity data on this installation.';
  }
}

function startupRecoveryLabel(recovery: ApplicationStartupRecovery): string {
  switch (recovery) {
    case 'retry-startup':
      return 'Retry startup';
    case 'reset-preferences':
      return 'Reset preferences';
    case 'reauthenticate':
      return 'Sign in again';
    case 'reset-installation':
      return 'Reset this installation';
  }
}

const STARTUP_STATUS_COPY = {
  'host-contract': {
    heading: 'Device integration could not be prepared',
    consequence: 'Trinity cannot safely use this host yet.',
  },
  'preference-hydration': {
    heading: 'Safe settings could not be prepared',
    consequence: 'Trinity cannot establish a safe settings baseline.',
  },
  'account-registry': {
    heading: 'Accounts could not be restored',
    consequence: 'The required Account session is unavailable.',
  },
  'room-library': {
    heading: 'Rooms could not be prepared',
    consequence: 'The required Room library is unavailable.',
  },
  'room-order': {
    heading: 'Saved Room ordering could not be prepared',
    consequence: 'Rooms may not use their saved order.',
  },
  'browser-storage-persistence': {
    heading: 'Protected local storage could not be prepared',
    consequence: 'Local Trinity data may be cleared under storage pressure.',
  },
  workspace: {
    heading: 'The workspace could not be restored',
    consequence: 'Trinity cannot open a safe application destination.',
  },
  readiness: {
    heading: 'Application readiness could not be confirmed',
    consequence: 'Trinity cannot safely expose the workspace yet.',
  },
} as const satisfies Record<
  ApplicationStartupProducer,
  { readonly heading: string; readonly consequence: string }
>;

function startupStatusEntry(
  settlement: ApplicationStartupProducerSettlement,
): StartupStatusEntry {
  return {
    producer: settlement.producer,
    stage: settlement.stage,
    ...STARTUP_STATUS_COPY[settlement.producer],
  };
}

function startupSettlementOrder(
  a: ApplicationStartupProducerSettlement,
  b: ApplicationStartupProducerSettlement,
): number {
  return (
    APPLICATION_STARTUP_STAGES.indexOf(a.stage) -
      APPLICATION_STARTUP_STAGES.indexOf(b.stage) ||
    APPLICATION_STARTUP_PRODUCERS.indexOf(a.producer) -
      APPLICATION_STARTUP_PRODUCERS.indexOf(b.producer)
  );
}

function platformKind(): 'web' | 'ios' | 'android' | 'desktop' {
  if (isElectronRenderer()) return 'desktop';
  if (isInstalledNativePlatform()) return isNativeIos() ? 'ios' : 'android';
  return 'web';
}

function orderOf(capability: string): number {
  const index = CAPABILITY_ORDER.indexOf(
    capability as (typeof CAPABILITY_ORDER)[number],
  );
  return index < 0 ? CAPABILITY_ORDER.length : index;
}
