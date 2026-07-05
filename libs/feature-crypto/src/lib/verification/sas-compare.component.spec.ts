import { fireEvent, render } from '@testing-library/angular';
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
});
