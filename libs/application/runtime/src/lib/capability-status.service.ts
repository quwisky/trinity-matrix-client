import {
  Injectable,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import type { BannerPrompt } from '@trinity/application/workspace';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import {
  TrustService,
  TrustSlotForecastService,
  type SlotForecast,
  type TrustStatus,
} from '@trinity/data-access/trust';
import {
  BUILD_INFO,
  isElectronRenderer,
  isInstalledNativePlatform,
  isNativeIos,
} from '@trinity/platform-native';
import type { CapabilityRecoveryOutcome } from '@trinity/runtime/projection';
import { take } from 'rxjs';
import { ApplicationRuntimeService } from './application-runtime.service';
import {
  CapabilityHealthService,
  type ApplicationCapabilityHealth,
} from './capability-health.service';
import {
  capabilityStatusCopy,
  type CapabilityStatusCopy,
} from './capability-status.catalog';
import { PointerPressService } from './pointer-press.service';
import {
  secondaryRecoveryLabel,
  startupBlockerConsequence,
  startupRecoveryLabel,
  startupSettlementOrder,
  startupStatusEntry,
  type StartupStatusEntry,
} from './startup-status.copy';
import { SystemStatusVisibilityService } from './system-status-visibility.service';

export { secondaryRecoveryLabel, type StartupStatusEntry };

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

/** The trust state the slot is decided on, and whether it is only the forecast. */
interface SlotTrust {
  readonly status: TrustStatus;
  readonly elsewhere: boolean;
  readonly forecast: boolean;
}

/** What the slot shows: which banner, and the trust state its prompt is drawn from. */
interface SlotState {
  readonly slot: 'status' | 'encryption' | null;
  readonly trust: SlotTrust;
}

export interface CapabilityStatusGroup {
  readonly capability: string;
  readonly entries: readonly CapabilityStatusEntry[];
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
  private readonly trust = inject(TrustService);
  private readonly dismissed = signal<ReadonlyMap<string, string>>(new Map());
  private readonly copied = signal(false);
  private readonly slotHeldStatus = signal(false);
  private readonly press = inject(PointerPressService);
  private readonly slotForecast = inject(TrustSlotForecastService);
  /** Trust has reported that it cannot read this Account's status (dismissed or not). */
  private readonly trustFailed = computed(() =>
    this.health
      .problems()
      .some(
        ({ capability, operation }) =>
          capability === 'trust' && operation === 'projection',
      ),
  );
  /** The trust state the slot is decided on: the live one, or the forecast until it arrives. */
  private readonly slotTrust = computed<SlotTrust>(() => {
    const live = this.trust.status();
    if (live !== 'unknown') {
      return {
        status: live,
        elsewhere: this.trust.recoverySetupElsewhere(),
        forecast: false,
      };
    }
    // A reported Trust failure ends the forecast at once: its notice takes the slot.
    const forecast = this.trustFailed() ? null : this.slotForecast.forecast();
    if (!forecast) return { status: live, elsewhere: false, forecast: false };
    return forecast === 'setup-elsewhere'
      ? { status: 'needs-setup', elsewhere: true, forecast: true }
      : { status: forecast, elsewhere: false, forecast: true };
  });
  /**
   * The single global banner slot, by priority: a blocking capability error, then the
   * encryption prompt (the user's one pending setup step), then a limited capability
   * (non-blocking, reachable from System Status). Guidance to set up recovery on another
   * device is no step on this one, so it takes the slot only when nothing is limited.
   * Per-room banners sit outside this slot. Until the live trust status arrives, the
   * Account's forecast decides it the same way, so the banner that will appear holds its
   * space from the first frame.
   */
  private readonly liveSlot = computed<'status' | 'encryption' | null>(() => {
    if (this.hasBlocking()) return 'status';
    const { status: trust, elsewhere } = this.slotTrust();
    const limited = this.visibleEntries().length > 0;
    if (trust === 'needs-setup' && elsewhere)
      return limited ? 'status' : 'encryption';
    if (
      trust === 'needs-setup' ||
      trust === 'needs-recovery' ||
      trust === 'needs-verification'
    )
      return 'encryption';
    return limited ? 'status' : null;
  });

  /**
   * The slot as rendered and the trust state its prompt is drawn from, latched together:
   * while a pointer is pressed neither changes, so a tap never straddles the slot or its
   * content growing, shrinking or changing kind above it. The change applies on release.
   */
  private readonly slotState = linkedSignal<
    { live: SlotState; pressed: boolean },
    SlotState
  >({
    source: () => ({
      live: { slot: this.liveSlot(), trust: this.slotTrust() },
      pressed: this.press.pressed(),
    }),
    computation: ({ live, pressed }, previous) =>
      pressed && previous ? previous.value : live,
  });

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
  /** The slot as rendered: {@link liveSlot}, except that a change waits for a press to end. */
  readonly bannerSlot = computed(() => this.slotState().slot);
  /**
   * The encryption prompt the slot holds; `null` unless the slot is `'encryption'`. Its
   * kind is held with the slot. It is perceivable only when the live status confirms that
   * kind and the slot is not held: a forecast, and a held prompt the live status no longer
   * supports, are placeholders of the same kind and height until the press ends.
   */
  readonly bannerPrompt = computed<BannerPrompt | null>(
    () => {
      const { slot, trust } = this.slotState();
      const kind = promptKind(trust);
      if (slot !== 'encryption' || !kind) return null;
      const live = this.slotTrust();
      const confirmed =
        !trust.forecast && !live.forecast && promptKind(live) === kind;
      return { kind, placeholder: !confirmed };
    },
    {
      equal: (a, b) =>
        a === b ||
        (a !== null &&
          b !== null &&
          a.kind === b.kind &&
          a.placeholder === b.placeholder),
    },
  );
  /**
   * Whether the slot has held the status notice in this app session. Only then can a
   * prompt replace that two-action notice, so only then does the prompt keep the
   * notice's height (`placement="global"` on the banner). Sticky: the notice can take the
   * slot back at any time.
   */
  readonly bannerSlotReserved = this.slotHeldStatus.asReadonly();
  /** Names what is limited: the one problem's heading, or up to two capability names. */
  readonly bannerMessage = computed(() => {
    const entries = this.visibleEntries();
    if (entries.length === 0) return '';
    if (entries.length === 1) return `${entries[0]!.copy.heading}.`;
    const names = [...new Set(entries.map(({ copy }) => copy.capability))].sort(
      (a, b) => orderOf(a) - orderOf(b),
    );
    const rest = names.length - 2;
    return rest > 0
      ? `Limited: ${names[0]}, ${names[1]} and ${rest} more.`
      : `Limited: ${names.join(' and ')}.`;
  });
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
  /** The confirmed second way out of a blocked startup, when the failure offers one. */
  readonly startupSecondaryRecovery = computed(() => {
    const state = this.runtime.state();
    return state.phase === 'blocked' && state.failure.secondaryRecovery
      ? secondaryRecoveryLabel(state.failure.secondaryRecovery)
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

  constructor() {
    // Recorded as the slot changes rather than derived when read: a lazy derivation would
    // miss a notice that nobody asked about before the prompt replaced it.
    effect(() => {
      if (this.bannerSlot() === 'status') this.slotHeldStatus.set(true);
    });
  }

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
      state.phase === 'starting' ||
      state.phase === 'blocked' ||
      state.phase === 'waiting-for-session'
        ? 'startup'
        : 'session';
    const attempt = 'attempt' in state ? state.attempt : 0;
    return JSON.stringify(
      {
        generatedBy: 'Trinity System status',
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

/** The encryption prompt a trust state asks for, if any. */
function promptKind({ status, elsewhere }: SlotTrust): SlotForecast | null {
  if (status === 'needs-setup' && elsewhere) return 'setup-elsewhere';
  return status === 'needs-setup' ||
    status === 'needs-recovery' ||
    status === 'needs-verification'
    ? status
    : null;
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
