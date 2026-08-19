import {
  Directive,
  computed,
  output,
  signal,
  type Signal,
} from '@angular/core';

/**
 * Turn the host into a drop target for files dragged in from the desktop.
 *
 * A host directive rather than markup: both message lists are template fragments with no
 * wrapper element of their own, and the target has to be the whole conversation — dropping a
 * screenshot "on the room" is the gesture, not dropping it on a particular strip of it.
 *
 * Two details are load-bearing and neither is obvious:
 *
 * - **`dragover` must `preventDefault()`** or the browser never fires `drop` at all. The
 *   handler looks like a no-op and is the only reason any of this works.
 * - **`dragenter`/`dragleave` are counted, not toggled.** Moving the pointer onto a child
 *   fires `dragleave` on the parent *before* `dragenter` on the child, so a boolean flag
 *   flickers off and on for every element crossed. The depth counter is what makes the
 *   overlay hold steady across a timeline full of message rows.
 */
@Directive({
  selector: '[trnFileDrop]',
  host: {
    '(dragenter)': 'onDragEnter($event)',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave()',
    '(drop)': 'onDrop($event)',
  },
})
export class TrnFileDropDirective {
  /** Files were dropped on the host. Never empty. */
  readonly filesDropped = output<readonly File[]>();

  private readonly depth = signal(0);

  /** Whether a file drag is currently over the host, for the "drop to attach" affordance. */
  readonly active: Signal<boolean> = computed(() => this.depth() > 0);

  protected onDragEnter(event: DragEvent): void {
    if (!this.carriesFiles(event)) {
      return;
    }
    this.depth.update((current) => current + 1);
  }

  protected onDragOver(event: DragEvent): void {
    if (!this.carriesFiles(event)) {
      return;
    }
    // Without this the drop event never arrives — the default action is "reject the drag".
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  protected onDragLeave(): void {
    // Floor at zero: a drag that began outside the host can leave it without ever having
    // entered, and a negative depth would then need two enters to show the overlay again.
    this.depth.update((current) => Math.max(0, current - 1));
  }

  protected onDrop(event: DragEvent): void {
    this.depth.set(0);
    if (!this.carriesFiles(event)) {
      return;
    }
    event.preventDefault(); // or the browser navigates to the dropped file
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) {
      this.filesDropped.emit(files);
    }
  }

  /**
   * Whether this drag is files rather than text, a link, or a message being dragged inside
   * the app. Checked on every handler: without it, selecting a word and dragging it across
   * the timeline would raise the overlay and swallow the browser's own default.
   */
  private carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') ?? false;
  }
}
