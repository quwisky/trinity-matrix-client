import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnDialogRef } from '@trinity/components/overlay';
import { type PresentedMediaReference } from '@trinity/data-access/media';
import { FileSaveService } from '@trinity/platform-native';
import { HostFileExportService } from '@trinity/runtime/host';
import { MediaSaveService } from '../media-save.service';
import {
  REST_VIEW,
  backdropOpacity,
  clampScale,
  clampView,
  containedSize,
  doubleTapView,
  isDoubleTap,
  isTap,
  shouldDismiss,
  zoomAbout,
  type ImageView,
  type ViewPoint,
} from './lightbox-gestures';

/** A finger's own click follows its lift within this long; a click much later is not its. */
const FINGER_CLICK_WINDOW_MS = 500;

/**
 * A full-resolution image, filling the viewport over a dark backdrop.
 *
 * Opened through {@link TrnSurfaceService}, not rendered inline in the timeline row, so it
 * gets the CDK dialog's focus trap, inert page behind it and top-of-stack overlay that a
 * row whose ancestors may clip it or open a stacking context cannot give.
 *
 * With a mouse the viewer fills the dialog pane and closes on any click (`zoom-out`). Its
 * padded surround is therefore the usable backdrop; CDK's own backdrop sits behind the
 * full-viewport pane and still owns modal isolation.
 *
 * Touch works the way a phone's photo viewer does: a tap shows or hides the controls, a double
 * tap or pinch zooms, a zoomed image pans, and a swipe down drags the image away to dismiss.
 * The drag writes the transform straight to the element, as the other swipe gestures do, so no
 * render sits between a finger and a frame.
 */

@Component({
  selector: 'trn-lightbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent],
  host: {
    class: 'lightbox',
    '[class.lightbox--bare]': '!controls()',
    '[class.lightbox--touching]': 'touching()',
    '(click)': 'hostClick($event)',
    '(keydown)': 'revealControls()',
    '(focusin)': 'revealControls()',
    '(window:resize)': 'refit()',
    '(pointerdown)': 'pointerDown($event)',
    '(pointermove)': 'pointerMove($event)',
    '(pointerup)': 'pointerUp($event)',
    '(pointercancel)': 'pointerCancel($event)',
  },
  templateUrl: './lightbox.component.html',
  styleUrl: './lightbox.component.scss',
})
export class LightboxComponent {
  private readonly mediaSave = inject(MediaSaveService);
  private readonly files = inject(FileSaveService);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly image =
    viewChild.required<ElementRef<HTMLImageElement>>('image');
  private readonly exportSupported = toSignal(
    inject(HostFileExportService)
      .support()
      .pipe(map((support) => support.kind === 'supported')),
    { initialValue: false },
  );
  private readonly pointers = new Map<number, ViewPoint>();

  private view: ImageView = REST_VIEW;
  private start: { at: number; point: ViewPoint; view: ImageView } | null =
    null;
  private pinch: { distance: number; mid: ViewPoint; view: ImageView } | null =
    null;
  private travel = 0;
  private multi = false;
  private dismissing = false;
  private lastTap: { at: number; point: ViewPoint } | null = null;
  /** When the last finger lifted: its trailing click is already handled by the gestures. */
  private fingerLiftedAt = -Infinity;
  /** The viewer's box, read once per touch rather than on every move. */
  private rect: DOMRect | null = null;

  /** Whether THIS item is being saved; other items' saves do not affect the button. */
  protected readonly busy = computed(() =>
    this.mediaSave.isSaving(this.media()),
  );
  /** The phone shows the controls only until a tap hides them; a mouse always has them. */
  protected readonly controls = signal(true);
  protected readonly touching = signal(false);
  /** Natively the host's save is the system share sheet, so name the action for what it does. */
  protected readonly shares = computed(
    () => this.exportSupported() && this.files.nativeAvailable,
  );

  readonly src = input.required<string>();
  readonly filename = input<string>('');
  /** The attachment being viewed; what the download button saves. */
  readonly media = input.required<PresentedMediaReference>();

  /** Save without letting the click reach the host, which closes the viewer on any click. */
  protected download(event: Event): void {
    event.stopPropagation();
    // Kept enabled (aria-disabled) while busy so focus stays put and a tap does not fall
    // through to the close-on-click host.
    if (!this.busy()) this.mediaSave.save(this.media());
  }

  protected close(): void {
    this.dialogRef.close();
  }

  protected hostClick(event: MouseEvent): void {
    if (event.timeStamp - this.fingerLiftedAt < FINGER_CLICK_WINDOW_MS) return;
    this.close();
  }

  /** Hidden controls come back for a keyboard or screen reader user reaching for them. */
  protected revealControls(): void {
    this.controls.set(true);
  }

  /** A resize or rotation changes the box the pan offsets were measured in. */
  protected refit(): void {
    this.rect = null;
    this.show(clampView(this.view, this.displayed()));
  }

  protected pointerDown(event: PointerEvent): void {
    if (
      event.pointerType === 'mouse' ||
      (event.target as Element).closest('button') ||
      this.dismissing
    ) {
      return;
    }
    if (this.pointers.size === 0) {
      this.rect = this.host.nativeElement.getBoundingClientRect();
    }
    this.host.nativeElement.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, this.point(event));
    this.touching.set(true);
    if (this.pointers.size === 1) {
      this.travel = 0;
      this.multi = false;
      this.rebase(event.timeStamp);
    } else {
      this.multi = true;
      this.pinch = this.pinchFrom(this.view);
    }
  }

  protected pointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, this.point(event));
    const box = this.displayed();
    if (this.pinch && this.pointers.size === 2) {
      const now = this.pinchFrom(this.view);
      const scale = clampScale(
        (this.pinch.view.scale * now.distance) / this.pinch.distance,
      );
      const zoomed = zoomAbout(this.pinch.view, scale, this.pinch.mid);
      this.show(
        clampView(
          {
            scale,
            x: zoomed.x + now.mid.x - this.pinch.mid.x,
            y: zoomed.y + now.mid.y - this.pinch.mid.y,
          },
          box,
        ),
      );
      return;
    }
    const start = this.start;
    if (!start) return;
    const here = this.pointers.get(event.pointerId) as ViewPoint;
    const dx = here.x - start.point.x;
    const dy = here.y - start.point.y;
    this.travel = Math.max(this.travel, Math.hypot(dx, dy));
    if (this.multi || start.view.scale > 1) {
      this.show(
        clampView(
          { ...start.view, x: start.view.x + dx, y: start.view.y + dy },
          box,
        ),
      );
    } else {
      // Dragging back up past where the finger started leaves no pull to release from.
      const pull = dy > 0 && dy > Math.abs(dx) ? dy : 0;
      this.show({ scale: 1, x: 0, y: pull });
      this.host.nativeElement.style.setProperty(
        '--lightbox-dim',
        String(backdropOpacity(pull, this.rect?.height || 1)),
      );
    }
  }

  protected pointerUp(event: PointerEvent): void {
    this.release(event, false);
  }

  protected pointerCancel(event: PointerEvent): void {
    this.release(event, true);
  }

  private release(event: PointerEvent, cancelled: boolean): void {
    const start = this.start;
    if (!this.pointers.delete(event.pointerId)) return;
    this.fingerLiftedAt = event.timeStamp;
    if (this.pointers.size > 0) {
      // One finger of a pinch is still down: it carries on as a pan from the current view.
      this.rebase(event.timeStamp);
      this.pinch = null;
      return;
    }
    this.touching.set(false);
    this.pinch = null;
    this.start = null;
    if (!start) return;
    const elapsed = event.timeStamp - start.at;
    if (this.multi) {
      this.show(this.view.scale <= 1.02 ? REST_VIEW : this.view);
    } else if (cancelled) {
      this.settle(start.view);
    } else if (isTap(this.travel, elapsed)) {
      this.settle(start.view);
      this.tap(this.point(event), event.timeStamp);
    } else if (this.view.y > 0 && this.view.scale === 1) {
      const height = this.rect?.height || 1;
      if (shouldDismiss(this.view.y, elapsed, height)) {
        this.dismissing = true;
        this.dialogRef.close();
        return;
      }
      this.settle(start.view);
    }
  }

  private tap(point: ViewPoint, at: number): void {
    if (isDoubleTap(this.lastTap, at, point)) {
      this.lastTap = null;
      // The first tap of the pair toggled the controls; the zoom takes that back.
      this.toggleControls();
      this.show(clampView(doubleTapView(this.view, point), this.displayed()));
      return;
    }
    this.lastTap = { at, point };
    this.toggleControls();
  }

  /** Hiding must not leave focus on a control nobody can see, where Enter would act unseen. */
  private toggleControls(): void {
    if (this.controls()) {
      const focused = document.activeElement;
      if (focused && focused.closest('.lightbox__actions')) {
        this.host.nativeElement
          .closest<HTMLElement>('[role="dialog"]')
          ?.focus();
        (focused as HTMLElement).blur();
      }
    }
    this.controls.update((shown) => !shown);
  }

  /** Back to the view the gesture began with, easing there. */
  private settle(view: ImageView): void {
    this.host.nativeElement.style.removeProperty('--lightbox-dim');
    this.show(view);
  }

  private show(view: ImageView): void {
    this.view = view;
    this.image().nativeElement.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  private rebase(at: number): void {
    const [first] = this.pointers.values();
    this.start = { at, point: first, view: this.view };
  }

  /** What the image really covers, which a `contain`-fitted element box overstates. */
  private displayed() {
    const image = this.image().nativeElement;
    return containedSize(
      { width: image.clientWidth, height: image.clientHeight },
      { width: image.naturalWidth, height: image.naturalHeight },
    );
  }

  /** Finger positions are kept relative to the viewer's centre, where the zoom is anchored. */
  private point(event: PointerEvent): ViewPoint {
    const rect = (this.rect ??=
      this.host.nativeElement.getBoundingClientRect());
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
  }

  private pinchFrom(view: ImageView) {
    const [a, b] = [...this.pointers.values()];
    return {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      view,
    };
  }
}
