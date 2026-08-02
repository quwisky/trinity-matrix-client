import { fireEvent, render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { SasCompareComponent } from './sas-compare.component';

const EMOJI = [
  { glyph: '🐶', name: 'Dog' },
  { glyph: '🐱', name: 'Cat' },
];

describe('SasCompareComponent', () => {
  it('renders an item per emoji, labelled by name', async () => {
    const { container } = await render(SasCompareComponent, {
      inputs: { emoji: EMOJI },
    });

    expect(container.querySelectorAll('.emoji__item').length).toBe(2);
    expect(container.textContent).toContain('Dog');
    expect(container.textContent).toContain('Cat');
    // Glyphs are decorative for assistive tech.
    expect(
      container.querySelector('.emoji__glyph')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('asks for an answer until it gets one', async () => {
    const { container } = await render(SasCompareComponent, {
      inputs: { emoji: EMOJI },
    });

    expect(container.querySelector('[data-testid="sas-match"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sas-waiting"]')).toBeNull();
  });

  it('emits match / mismatch / cancel from the action buttons', async () => {
    const events: string[] = [];
    const { container } = await render(SasCompareComponent, {
      inputs: { emoji: EMOJI },
      on: {
        match: vi.fn(() => events.push('match')),
        mismatch: vi.fn(() => events.push('mismatch')),
        cancelled: vi.fn(() => events.push('cancel')),
      },
    });

    const buttons = [...container.querySelectorAll('button')] as HTMLElement[];
    fireEvent.click(
      buttons.find(
        (b) =>
          b.textContent?.includes('match') && !b.textContent?.includes("don't"),
      )!,
    );
    fireEvent.click(buttons.find((b) => b.textContent?.includes("don't"))!);
    fireEvent.click(buttons.find((b) => b.textContent?.includes('Cancel'))!);

    expect(events).toEqual(['match', 'mismatch', 'cancel']);
  });

  // Once "They match" is answered, the exchange hangs on the other device — so the
  // answer must be spent (no double-confirm) and the wait must be visible.
  it('swaps the answer for a spinner once confirmed, keeping the emoji and Cancel', async () => {
    const { container } = await render(SasCompareComponent, {
      inputs: { emoji: EMOJI, confirmed: true },
    });

    const waiting = container.querySelector('[data-testid="sas-waiting"]');
    expect(waiting).not.toBeNull();
    expect(waiting?.getAttribute('aria-live')).toBe('polite');
    expect(waiting?.querySelector('hlm-spinner')).not.toBeNull();
    expect(waiting?.textContent).toMatch(/waiting for the other device/i);

    expect(container.querySelector('[data-testid="sas-match"]')).toBeNull();
    expect(container.querySelector('[data-testid="sas-mismatch"]')).toBeNull();
    // The emoji stay up (the other device may still be waiting to be read), and the
    // user is never trapped in the wait.
    expect(container.querySelectorAll('.emoji__item').length).toBe(2);
    expect(container.textContent).toContain('Cancel');
  });
});
