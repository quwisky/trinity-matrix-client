import {
  Directive,
  computed,
  output,
  signal,
  type Signal,
} from '@angular/core';

/**
 * Turn the host into a drop target for files dragged in from the desktop. A host directive because
 * both message lists are template fragments with no wrapper element, and the target must be the
 * whole conversation.
 *
 * Two details are load-bearing:
 *
 * - **`dragover` must `preventDefault()`** or the browser never fires `drop`.
 * - **`dragenter`/`dragleave` are counted, not toggled.** Moving onto a child fires `dragleave` on
 *   the parent *before* `dragenter` on the child, so a boolean flickers for every element crossed.
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
    // Without this the drop event never arrives: the default action is "reject the drag".
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  protected onDragLeave(): void {
    // Floor at zero: a drag that began outside the host can leave without entering, and a negative
    // depth would then need two enters to show the overlay again.
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
   * Whether this drag is files rather than text, a link, or an in-app message drag. Checked on every
   * handler: otherwise dragging selected text across the timeline would raise the overlay and
   * swallow the browser's own default.
   */
  private carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') ?? false;
  }
}
