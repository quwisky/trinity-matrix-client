import { fireEvent, render, screen } from '@trinity/testing';
import { type MemberSummary } from '@trinity/data-access/room-administration';
import { describe, expect, it } from 'vitest';
import { SearchSenderPickerComponent } from './search-sender-picker.component';

const person = (i: number): MemberSummary =>
  ({
    userId: `@p${i}:hs`,
    roomDisplayName: i % 2 ? `Odd ${i}` : `Even ${i}`,
  }) as MemberSummary;

async function build(count: number) {
  const picked: ({ id: string; name: string } | null)[] = [];
  const result = await render(SearchSenderPickerComponent, {
    inputs: { members: Array.from({ length: count }, (_, i) => person(i)) },
    on: { picked: (v: { id: string; name: string } | null) => picked.push(v) },
  });
  return { ...result, picked };
}

const options = (container: HTMLElement) =>
  [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid="search-sender-option"]',
    ),
  ].map((el) => el.textContent?.trim());

describe('SearchSenderPickerComponent', () => {
  it('shows a capped list of a 10,000-member room, and says how many more there are', async () => {
    const { container } = await build(10_000);

    expect(options(container)).toHaveLength(20);
    expect(
      container.querySelector('[data-testid="search-sender-more"]')
        ?.textContent,
    ).toContain('9,980 more');
  });

  it('narrows the list as you type, by name or user id', async () => {
    const { container, fixture } = await build(10_000);
    const field = screen.getByRole('searchbox', { name: 'Find a person' });

    fireEvent.input(field, { target: { value: 'odd 999' } });
    fixture.detectChanges();
    expect(options(container)).toEqual([
      'Odd 999',
      'Odd 9991',
      'Odd 9993',
      'Odd 9995',
      'Odd 9997',
      'Odd 9999',
    ]);

    fireEvent.input(field, { target: { value: '@p4:hs' } });
    fixture.detectChanges();
    expect(options(container)).toEqual(['Even 4']);
  });

  it('picks a person, or anyone', async () => {
    const { container, picked } = await build(3);

    fireEvent.click(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="search-sender-option"]',
      )[1],
    );
    fireEvent.click(screen.getByRole('button', { name: 'Anyone' }));
    expect(picked).toEqual([{ id: '@p1:hs', name: 'Odd 1' }, null]);
  });
});
