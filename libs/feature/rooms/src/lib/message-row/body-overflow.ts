import {
  Directive,
  ElementRef,
  Injectable,
  OnDestroy,
  effect,
  inject,
  input,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';

/**
 * Lines a message body may have and still be shown whole (spec C). A longer body collapses to
 * 20 lines (`.msg__clamp--collapsed` in rendered-markdown.scss); a body of 21 to 24 lines is
 * shown whole, so the button never hides only a line or two.
 */
export const BODY_LIMIT_LINES = 24;

/**
 * Which message bodies are taller than {@link BODY_LIMIT_LINES}: one `ResizeObserver` per list,
 * provided by the timeline and the thread view. The comparison happens inside the observer's
 * callback, after layout, and writes one signal per row, so no render path reads layout. The
 * observed element is the uncapped body inside the clamp wrapper, so content that arrives later
 * (an image, maths) fires the observer again. Signals are keyed by row id and outlive the
 * element: a body replaced by an edit keeps feeding the same row.
 */
@Injectable()
export class BodyOverflowObserver implements OnDestroy {
  private readonly long = new Map<string, WritableSignal<boolean>>();
  private readonly rows = new Map<Element, string>();
  private observer: ResizeObserver | null = null;

  /** Whether row `id`'s body is taller than the limit; false until measured. */
  overflowing(id: string): Signal<boolean> {
    return this.entry(id).asReadonly();
  }

  observe(body: Element, id: string): void {
    this.rows.set(body, id);
    if (!this.observer && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => this.measure(entries));
    }
    this.observer?.observe(body);
  }

  unobserve(body: Element): void {
    this.rows.delete(body);
    this.observer?.unobserve(body);
  }

  /**
   * Forget the measurements of rows no longer shown: the list moved to another room. Reset
   * those signals rather than drop them, so a row that already read its signal keeps
   * listening to the one that a later measurement writes. A body still shown (its room's rows
   * arrived before the room id changed) keeps its measurement, which the observer goes on
   * updating: row ids are event ids, unique across rooms, so the value is still that row's,
   * and resetting it would show a long body uncollapsed for a frame.
   */
  clear(): void {
    const shown = new Set(this.rows.values());
    for (const [id, flag] of this.long) {
      if (!shown.has(id)) flag.set(false);
    }
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.rows.clear();
    this.long.clear();
  }

  private measure(entries: readonly ResizeObserverEntry[]): void {
    for (const entry of entries) {
      const id = this.rows.get(entry.target);
      if (id === undefined) continue;
      const limit = BODY_LIMIT_LINES * lineHeightOf(entry.target) + 1;
      this.entry(id).set(heightOf(entry) > limit);
    }
  }

  private entry(id: string): WritableSignal<boolean> {
    let entry = this.long.get(id);
    if (!entry) {
      entry = signal(false);
      this.long.set(id, entry);
    }
    return entry;
  }
}

/**
 * The body's full height from the entry itself, so no layout is read for it. The observed body
 * sits inside the clamp wrapper and is never clipped itself, so its border box is its whole
 * content height, padding included, as `scrollHeight` gives it. Every browser on the
 * `.browserslistrc` floor reports `borderBoxSize`; `scrollHeight` covers any that does not.
 */
function heightOf(entry: ResizeObserverEntry): number {
  return entry.borderBoxSize?.[0]?.blockSize ?? entry.target.scrollHeight;
}

/**
 * The body's line height in pixels — `--trinity-type-message-line-height` × the font size, as
 * the browser resolved it. Read inside the observer callback, after layout.
 */
function lineHeightOf(element: Element): number {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style?.lineHeight ?? '');
  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    return lineHeight;
  }
  const fontSize = Number.parseFloat(style?.fontSize ?? '');
  return (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16) * 1.5;
}

/** Hands a message body to its list's {@link BodyOverflowObserver}, while one is provided. */
@Directive({ selector: '[trnBodyMeasure]' })
export class BodyMeasureDirective {
  private readonly observer = inject(BodyOverflowObserver, { optional: true });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The row whose body this is. */
  readonly rowId = input.required<string>({ alias: 'trnBodyMeasure' });

  constructor() {
    effect((onCleanup) => {
      const id = this.rowId();
      const observer = this.observer;
      if (!observer) {
        return;
      }
      const body = this.host.nativeElement;
      observer.observe(body, id);
      onCleanup(() => observer.unobserve(body));
    });
  }
}
