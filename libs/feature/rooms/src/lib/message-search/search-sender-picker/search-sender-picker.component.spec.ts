import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@trinity/testing';
import { type MemberSummary } from '@trinity/data-access/room-administration';
import { describe, expect, it } from 'vitest';
import { SearchSenderPickerComponent } from './search-sender-picker.component';

const person = (i: number): MemberSummary =>
  ({
    userId: `@p${i}:hs`,
    roomDisplayName: i % 2 ? `Odd ${i}` : `Even ${i}`,
  }) as MemberSummary;

async function build(count: number, selected: string | null = null) {
  const picked: ({ id: string; name: string } | null)[] = [];
  let dismissed = 0;
  const result = await render(SearchSenderPickerComponent, {
    inputs: {
      members: Array.from({ length: count }, (_, i) => person(i)),
      selected,
    },
    on: {
      picked: (v: { id: string; name: string } | null) => picked.push(v),
      dismissed: () => dismissed++,
    },
  });
  return { ...result, picked, dismissed: () => dismissed };
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

  it('announces how many more there are as a polite status', async () => {
    const { container } = await build(10_000);
    const more = container.querySelector('[data-testid="search-sender-more"]');
    expect(more?.getAttribute('role')).toBe('status');
  });

  it('takes focus when it opens', async () => {
    await build(3);
    TestBed.tick();
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'Find a person' }),
    );
  });

  it('moves between the field and the options with the arrow keys', async () => {
    await build(3);
    const field = screen.getByRole('searchbox', { name: 'Find a person' });
    field.focus();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Anyone' }),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent?.trim()).toBe('Even 0');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement?.textContent?.trim()).toBe('Even 2');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent?.trim()).toBe('Even 2');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(field);
  });

  it('closes on Escape from an option too', async () => {
    const { dismissed } = await build(3);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Anyone' }), {
      key: 'Escape',
    });
    expect(dismissed()).toBe(1);
  });

  it('marks the person the search is narrowed to', async () => {
    await build(3, '@p1:hs');
    expect(
      screen
        .getByRole('button', { name: 'Odd 1' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen
        .getByRole('button', { name: 'Anyone' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
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
