import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  type Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { CallService, CallStageService } from '@trinity/data-access/calls';

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

const hasArea = (rect: Rect | null): rect is Rect =>
  !!rect && rect.width > 0 && rect.height > 0;

/**
 * The active call's Element Call frame, app-wide. It lies over the stage a page registers, or
 * over the dock slot of the sidebar card; only its style moves, because re-parenting or
 * re-creating the iframe would reload Element Call and drop the call. Without a card, a strip
 * under the title bar stands in for it.
 */
@Component({
  selector: 'trn-call-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AsyncPipe, TrnButton, TrnIconComponent, TrnSpinnerComponent],
  templateUrl: './call-host.component.html',
  styleUrl: './call-host.component.scss',
})
export class CallHostComponent {
  private readonly calls = inject(CallService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly frame =
    viewChild<ElementRef<HTMLIFrameElement>>('callFrame');
  private readonly callStage = inject(CallStageService);
  private readonly stageRect = trackRect(this.callStage.element);
  private readonly dockRect = trackRect(this.callStage.dockElement);

  protected readonly call = this.calls.activeCall;
  // Cold: the strip's async pipes subscribe only while it renders.
  protected readonly elapsed$ = this.calls.elapsed();
  protected readonly participants$ = this.calls.activeCallParticipants();

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
      return hasArea(this.stageRect()) ? 'stage' : 'dock';
    },
  );

  protected readonly showStrip = computed(
    () =>
      (this.mode() === 'dock' || this.mode() === 'failed') &&
      !this.callStage.dockPresent(),
  );

  protected readonly rect = computed<Rect>(() => {
    switch (this.mode()) {
      case 'stage':
        return this.stageRect() ?? OFF_SCREEN;
      case 'dock': {
        const dock = this.dockRect();
        return hasArea(dock) ? dock : OFF_SCREEN;
      }
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
