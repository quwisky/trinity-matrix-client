import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  BannerComponent,
  TrnSpinnerComponent,
} from '@trinity/components/generic-content';
import { CallService, CallStageService } from '@trinity/data-access/calls';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

// Off-screen, the frame keeps rendering so the call's audio continues.
const OFF_SCREEN: Rect = { top: 0, left: -10000, width: 1, height: 1 };

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height);

const MOVE_EVENTS = ['animationend', 'scroll'] as const;

/** Follows `target`'s viewport rect through resizes, scrolls and finished animations. */
function trackRect(target: Signal<HTMLElement | null>): Signal<Rect | null> {
  const rect = signal<Rect | null>(null, { equal: sameRect });
  effect((onCleanup) => {
    const element = target();
    if (!element) {
      rect.set(null);
      return;
    }
    const measure = (): void => {
      const { top, left, width, height } = element.getBoundingClientRect();
      rect.set({ top, left, width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    // Pane slides move the target by transform alone, which no ResizeObserver reports.
    for (const type of MOVE_EVENTS) {
      document.addEventListener(type, measure, { capture: true });
    }
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      for (const type of MOVE_EVENTS) {
        document.removeEventListener(type, measure, { capture: true });
      }
    });
  });
  return rect.asReadonly();
}

/**
 * The active call's Element Call frame, app-wide. It lies over the stage a page registers,
 * or over the video slot of the dock, a bar at the bottom of the app; only its style moves, because re-parenting or re-creating
 * the iframe would reload Element Call and drop the call.
 */
@Component({
  selector: 'trn-call-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent, TrnButton, TrnIconComponent, TrnSpinnerComponent],
  templateUrl: './call-host.component.html',
  styleUrl: './call-host.component.scss',
})
export class CallHostComponent {
  private readonly calls = inject(CallService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly frame =
    viewChild<ElementRef<HTMLIFrameElement>>('callFrame');
  private readonly dockSlot = viewChild<ElementRef<HTMLElement>>('dockSlot');
  private readonly stageRect = trackRect(inject(CallStageService).element);
  private readonly slotRect = trackRect(
    computed(() => this.dockSlot()?.nativeElement ?? null),
  );

  private readonly belowMd = mediaQuerySignal(BELOW_MD_QUERY, this.destroyRef);
  /** The user's choice, which holds until the call ends. */
  private readonly videoChoice = linkedSignal<
    number | undefined,
    boolean | null
  >({
    source: () => this.calls.activeCall()?.id,
    computation: () => null,
  });

  protected readonly call = this.calls.activeCall;
  protected readonly videoShown = computed(
    () => this.videoChoice() ?? !this.belowMd(),
  );

  /** Keyed on the call id, so each call gets a fresh frame. */
  protected readonly callIds = computed(() => {
    const id = this.call()?.id;
    return id === undefined ? [] : [id];
  });

  protected readonly mode = computed<'stage' | 'dock' | 'hidden' | 'failed'>(
    () => {
      const state = this.call()?.state;
      if (state === 'failed') return 'failed';
      if (!state || state === 'ending') return 'hidden';
      const stage = this.stageRect();
      return stage && stage.width > 0 && stage.height > 0 ? 'stage' : 'dock';
    },
  );

  protected readonly rect = computed<Rect>(() => {
    switch (this.mode()) {
      case 'stage':
        return this.stageRect() ?? OFF_SCREEN;
      case 'dock':
        return (this.videoShown() && this.slotRect()) || OFF_SCREEN;
      default:
        return OFF_SCREEN;
    }
  });

  constructor() {
    effect((onCleanup) => {
      const frame = this.frame()?.nativeElement;
      if (!frame) return;
      // Untracked: attach reads call signals, and re-running would hang up.
      const subscription = untracked(() =>
        this.calls.attach(frame).subscribe(),
      );
      onCleanup(() => subscription.unsubscribe());
    });
  }

  protected toggleVideo(): void {
    this.videoChoice.set(!this.videoShown());
  }

  protected returnToCall(): void {
    const call = this.call();
    if (!call) return;
    this.workspace
      .navigate({
        kind: 'room',
        accountId: call.accountId,
        roomId: call.roomId,
        origin: 'room-action',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected hangUp(): void {
    this.calls.hangUp();
  }
}
