import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleMessageListComponent } from './simple-message-list/simple-message-list.component';

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
describe('message list — loading older', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };

  const strip = (container: HTMLElement) =>
    container.querySelector('.load-older');

  async function create() {
    const result = await render(SimpleMessageListComponent, {
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

  it('keeps it up long enough to read when the backfill finishes right after', async () => {
    const { container, fixture } = await create();

    fixture.componentRef.setInput('loadingOlder', true);
    TestBed.tick();
    advance(200);
    expect(strip(container)).not.toBeNull();

    fixture.componentRef.setInput('loadingOlder', false);
    TestBed.tick();
    advance(100);
    expect(strip(container)).not.toBeNull();

    advance(500);
    expect(strip(container)).toBeNull();
  });
});
