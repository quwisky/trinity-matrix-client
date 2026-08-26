import { type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleMessageListComponent } from './simple-message-list/simple-message-list.component';
import { VirtualMessageListComponent } from './virtual-message-list/virtual-message-list.component';
import type { MessageListBase } from './message-list-base';

/**
 * The "Loading older messages…" strip, and when it is allowed to appear.
 *
 * A new file rather than more tests in `simple-message-list.component.spec.ts`: that one is
 * already at 48 TestBed tests, and a TestBed test retains enough that a single file has
 * previously died part-way through and reported the rest as never run.
 *
 * Backfilling a page of history is usually faster than a person can register, so binding
 * `loadingOlder` straight to the template flashed this strip on most scrolls back — motion
 * at the top of the timeline, in exactly the spot being read. It goes through `delayedBusy`
 * now, and these pin the two ends of that: nothing for a quick load, and once shown it stays
 * long enough to be read.
 */
/**
 * Both lists, and the windowed one is not optional.
 *
 * `DEFAULT_VIRTUAL_TIMELINE` is true, so `VirtualMessageListComponent` is what ships. An
 * earlier version of this file tested only the simple list — the whole binding could be
 * reverted on the virtual one with the entire workspace still green, which is exactly how a
 * scroll-anchoring regression got through review.
 */
// Typed as the shared BASE rather than left to inference. `describe.each` widens the pair to
// a union of the two classes, and `render<T>(component: Type<T>, …)` cannot infer one `T` from
// a union — the two lists are not structurally compatible (`atBottom` exists on one only). The
// base is also the honest type: what this file tests is `MessageListBase.showLoadingOlder`,
// which is why both lists belong in the same table.
const LISTS: readonly (readonly [string, Type<MessageListBase>])[] = [
  ['simple', SimpleMessageListComponent],
  ['virtual (the default)', VirtualMessageListComponent],
];

describe.each(LISTS)('message list — loading older (%s)', (_label, List) => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };

  const strip = (container: HTMLElement) =>
    container.querySelector('.load-older');

  async function create() {
    const result = await render(List, {
      inputs: { messages: [], loadingOlder: false },
    });
    TestBed.tick();
    return result;
  }

  it('shows nothing for a backfill that returns quickly', async () => {
    const { container, fixture } = await create();

    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(100);
    expect(strip(container)).toBeNull();

    fixture.componentRef.setInput('loadingOlder', false);
    TestBed.tick();
    advance(2000);

    expect(strip(container)).toBeNull();
  });

  it('shows the strip once the backfill is slow enough to be worth mentioning', async () => {
    const { container, fixture } = await create();

    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(200);

    expect(strip(container)).not.toBeNull();
    expect(container.textContent).toContain('Loading older messages…');
  });

  it('disappears in the same pass the backfill finishes, not later', async () => {
    // THE property, and it is about layout rather than about looks. The strip is in flow
    // above the rows, and the windowed list's scroll restore folds its height into the
    // calculation that keeps the reader's place across a prepend. `TimelineService` prepends
    // the rows and clears `loadingOlder` together, so the strip has to go with them — held
    // even a moment longer, the restore measures 36px that is about to vanish and the
    // content jumps up by that much once it does.
    //
    // Asserted with no timer advance at all after the flag clears: anything that needs one
    // is, by definition, still on screen when the prepend lands.
    const { container, fixture } = await create();

    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(200);
    expect(strip(container)).not.toBeNull();

    fixture.componentRef.setInput('loadingOlder', false);
    TestBed.tick();

    expect(strip(container)).toBeNull();
  });

  it('judges the next backfill on its own duration, rather than flashing the strip at it', async () => {
    // What `minimumMs: 0` buys, and the ONLY thing about it that is observable. The AND in
    // `showLoadingOlder` already removes the strip with the prepend whatever the minimum is,
    // so a hold could never be seen on the way out — it would be seen on the way back in.
    // Scrolling back is repetitive: one slow page is routinely followed by several fast
    // ones, and a `delayedBusy` still serving out a hold is still "visible", so the next
    // backfill would skip the delay entirely and flash the strip for a page nobody noticed
    // was fetched. Set the minimum to anything above zero and this goes red.
    const { container, fixture } = await create();

    // A slow page: long enough to earn the strip.
    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(200);
    expect(strip(container)).not.toBeNull();

    fixture.componentRef.setInput('loadingOlder', false);
    TestBed.tick();
    advance(50);

    // A second page, requested well inside any minimum hold and answered faster than the
    // delay. It has earned nothing, so it shows nothing.
    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(100);

    expect(strip(container)).toBeNull();
  });
});
