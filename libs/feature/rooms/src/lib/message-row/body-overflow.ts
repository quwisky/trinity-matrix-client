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
 * How many rows measured long a list remembers once they are no longer rendered, so a long
 * row the virtual timeline brings back starts collapsed instead of whole for a frame. Long
 * bodies are rare; past this many, the oldest are forgotten and measured again on return.
 */
export const REMEMBERED_LONG_ROWS = 500;

/** A row's live measurement, and who still needs it. */
interface Entry {
  readonly long: WritableSignal<boolean>;
  /** Rows reading the signal ({@link BodyOverflowObserver.hold}). */
  holds: number;
  /** Body elements observed for the row. */
  bodies: number;
}

/**
 * Which message bodies are taller than {@link BODY_LIMIT_LINES}: one `ResizeObserver` per list,
 * provided by the timeline and the thread view. The comparison happens inside the observer's
 * callback, after layout, and writes one signal per row, so no render path reads layout. The
 * observed element is the uncapped body inside the clamp wrapper, so content that arrives later
 * (an image, maths) fires the observer again.
 *
 * A row's signal lives while the row holds it or a body for it is observed: a body replaced by
 * an edit keeps feeding the same row, and the entries stay as many as the rendered rows (#1361).
 * Past that, only the ids of rows measured long are remembered, up to
 * {@link REMEMBERED_LONG_ROWS} and until the list moves to another room.
 */
@Injectable()
export class BodyOverflowObserver implements OnDestroy {
  private readonly entries = new Map<string, Entry>();
  /** Rows last measured long, oldest first. */
  private readonly longIds = new Set<string>();
  private readonly rows = new Map<Element, string>();
  private observer: ResizeObserver | null = null;

  /**
   * Whether row `id`'s body is taller than the limit; false until measured, unless the row was
   * measured long before. Read it only while holding the row ({@link hold}), or a later
   * measurement may write a signal the reader no longer has.
   */
  overflowing(id: string): Signal<boolean> {
    return this.entry(id).long.asReadonly();
  }

  /** Keep row `id`'s measurement while a row reads it; call the returned function to let go. */
  hold(id: string): () => void {
    this.entry(id).holds++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const entry = this.entries.get(id);
      if (entry) {
        entry.holds--;
        this.release(id, entry);
      }
    };
  }

  observe(body: Element, id: string): void {
    this.rows.set(body, id);
    this.entry(id).bodies++;
    if (!this.observer && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => this.measure(entries));
    }
    this.observer?.observe(body);
  }

  unobserve(body: Element): void {
    const id = this.rows.get(body);
    this.rows.delete(body);
    this.observer?.unobserve(body);
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (id !== undefined && entry) {
      entry.bodies--;
      this.release(id, entry);
    }
  }

  /**
   * Forget the measurements of rows no longer shown: the list moved to another room. A row
   * still holding its signal has it reset rather than dropped, so it keeps listening to the
   * one that a later measurement writes. A body still shown (its room's rows arrived before
   * the room id changed) keeps its measurement, which the observer goes on updating: row ids
   * are event ids, unique across rooms, so the value is still that row's, and resetting it
   * would show a long body uncollapsed for a frame.
   */
  clear(): void {
    const shown = new Set(this.rows.values());
    for (const id of this.longIds) {
      if (!shown.has(id)) this.longIds.delete(id);
    }
    for (const [id, entry] of this.entries) {
      if (shown.has(id)) continue;
      entry.long.set(false);
      if (entry.holds === 0) this.entries.delete(id);
    }
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.rows.clear();
    this.entries.clear();
    this.longIds.clear();
  }

  private measure(entries: readonly ResizeObserverEntry[]): void {
    for (const entry of entries) {
      const id = this.rows.get(entry.target);
      if (id === undefined) continue;
      const limit = BODY_LIMIT_LINES * lineHeightOf(entry.target) + 1;
      const long = heightOf(entry) > limit;
      this.remember(id, long);
      this.entry(id).long.set(long);
    }
  }

  private remember(id: string, long: boolean): void {
    this.longIds.delete(id);
    if (!long) return;
    this.longIds.add(id);
    if (this.longIds.size > REMEMBERED_LONG_ROWS) {
      const oldest = this.longIds.values().next().value;
      if (oldest !== undefined) this.longIds.delete(oldest);
    }
  }

  /** Drop row `id`'s entry once no row reads it and no body for it is observed. */
  private release(id: string, entry: Entry): void {
    if (entry.holds <= 0 && entry.bodies <= 0) {
      this.entries.delete(id);
    }
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { long: signal(this.longIds.has(id)), holds: 0, bodies: 0 };
      this.entries.set(id, entry);
    }
    return entry;
  }
}

/**
 * The body's content height from the entry itself, so no layout is read for it: its lines, and
 * the margins of its last element, which its bottom padding keeps inside. Not the border box: a
 * formatted body pads itself by the focus-ring reach (and takes that back with a negative
 * margin) so its overflow clip keeps rings whole, and that padding is not a line. Every browser
 * on the `.browserslistrc` floor reports `contentBoxSize` and `contentRect`; for an entry that
 * carries neither, `scrollHeight` less the block padding.
 */
function heightOf(entry: ResizeObserverEntry): number {
  const content =
    entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect?.height;
  if (content !== undefined) {
    return content;
  }
  const style = entry.target.ownerDocument.defaultView?.getComputedStyle(
    entry.target,
  );
  const padding =
    (Number.parseFloat(style?.paddingTop ?? '') || 0) +
    (Number.parseFloat(style?.paddingBottom ?? '') || 0);
  return entry.target.scrollHeight - padding;
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
