import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TypingIndicatorComponent } from './typing-indicator.component';

/**
 * An element's text with runs of whitespace collapsed.
 *
 * The row interleaves its sentence with empty dot spans, so `textContent` carries interior
 * whitespace that a bare `.trim()` only happens to survive.
 */
const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('TypingIndicatorComponent', () => {
  it('names the typists, up to three, and summarises beyond that', async () => {
    const { fixture, container } = await render(TypingIndicatorComponent, {
      inputs: { names: ['Alice'] },
    });
    const row = () => container.querySelector('.typing-indicator');
    expect(text(row())).toBe('Alice is typing');

    fixture.componentRef.setInput('names', ['Alice', 'Bob']);
    fixture.detectChanges();
    expect(text(row())).toBe('Alice and Bob are typing');

    fixture.componentRef.setInput('names', ['Alice', 'Bob', 'Carol', 'Dave']);
    fixture.detectChanges();
    expect(text(row())).toBe('Several people are typing');
  });

  it('reserves its space whether or not anyone is typing', async () => {
    // jsdom applies no CSS, so this asserts only that the slot is PRESENT when idle —
    // that it has a reserved HEIGHT is measured in `composer-typing.spec.mts`.
    const { fixture, container } = await render(TypingIndicatorComponent, {
      inputs: { names: [] },
    });
    expect(container.querySelector('.typing-slot')).not.toBeNull();
    expect(container.querySelector('.typing-indicator')).toBeNull();

    fixture.componentRef.setInput('names', ['Alice']);
    fixture.detectChanges();
    expect(container.querySelectorAll('.typing-slot')).toHaveLength(1);
    expect(container.querySelector('.typing-indicator')).not.toBeNull();
  });

  it('draws three dots, and hides the visible row from assistive tech', async () => {
    const { container } = await render(TypingIndicatorComponent, {
      inputs: { names: ['Alice'] },
    });
    expect(container.querySelectorAll('.typing-dots__dot')).toHaveLength(3);
    // The visible row must not announce — the persistent region does that, and two live
    // regions over one fact announce it twice.
    expect(
      container.querySelector('.typing-indicator')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('keeps its live region mounted and tracks the name count through it', async () => {
    // Persistence is the point. A `role="status"` inserted together with its text is not
    // reliably announced, which is what the markup this replaced did.
    const { fixture, container } = await render(TypingIndicatorComponent, {
      inputs: { names: [] },
    });
    const status = () =>
      container.querySelector('[data-testid="typing-status"]');

    expect(status()).not.toBeNull();
    expect(text(status())).toBe('');

    fixture.componentRef.setInput('names', ['Alice']);
    fixture.detectChanges();
    expect(text(status())).toBe('Alice is typing');

    fixture.componentRef.setInput('names', ['Alice', 'Bob']);
    fixture.detectChanges();
    expect(text(status())).toBe('Alice and Bob are typing');

    fixture.componentRef.setInput('names', []);
    fixture.detectChanges();
    expect(status()).not.toBeNull();
    expect(text(status())).toBe('');
  });

  it('renders no live region when it does not own the announcement', async () => {
    // The thread panel's case: `m.typing` is room-scoped, so the panel shows the same
    // typists as the list behind it and would otherwise announce them a second time.
    const { container } = await render(TypingIndicatorComponent, {
      inputs: { names: ['Alice'], announce: false },
    });

    expect(container.querySelector('[data-testid="typing-status"]')).toBeNull();
    // …but the visible row is still there.
    expect(text(container.querySelector('.typing-indicator'))).toBe(
      'Alice is typing',
    );
  });
});
