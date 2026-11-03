import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, screen } from '@trinity/testing';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnSurfaceService } from '../surface-service/trn-surface.service';
import type { ActionSheetData } from './trn-action-list.component';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

const media = { narrow: false, coarse: false };

function data(handler = vi.fn(), react = vi.fn()): ActionSheetData {
  return {
    header: 'New message',
    reactions: [{ key: '👍', handler: react }],
    buttons: [
      { text: 'Create a room', icon: 'plus', testId: 'row-create', handler },
      { text: 'Archive', disabled: true, testId: 'row-archive' },
      {
        text: 'Leave',
        variant: 'danger',
        separatorBefore: true,
        testId: 'row-leave',
      },
      { text: 'Cancel', role: 'cancel', testId: 'row-cancel' },
    ],
  };
}

/**
 * WCAG 2.5.3 label in name: the reaction is named from its content, so the visible emoji is
 * part of the accessible name, and no aria-label replaces it (an emoji-only visible label is
 * something Axe cannot judge against an aria-label).
 */
function expectReactionNamedFromItsEmoji(): void {
  const react = screen.getByRole('button', { name: 'React with 👍' });
  expect(react.hasAttribute('aria-label')).toBe(false);
  const hidden = react.querySelector('.sr-only');
  expect(hidden?.textContent).toBe('React with');
  expect(react.textContent?.replace(hidden?.textContent ?? '', '').trim()).toBe(
    '👍',
  );
}

describe('TrnActionListComponent', () => {
  let surfaces: TrnSurfaceService;
  let opener: HTMLButtonElement;
  const tick = () => TestBed.inject(ApplicationRef).tick();

  beforeEach(() => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches:
            (query === BELOW_MD_QUERY && media.narrow) ||
            (query === '(pointer: coarse)' && media.coarse),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    opener = document.createElement('button');
    opener.textContent = 'New';
    document.body.append(opener);
    opener.focus();
    surfaces = TestBed.inject(TrnSurfaceService);
  });

  afterEach(() => {
    surfaces.closeAll();
    opener.remove();
    platform.mobile = false;
    media.narrow = false;
    media.coarse = false;
    vi.restoreAllMocks();
  });

  describe('as a menu beside its button on a large screen', () => {
    it('lists the rows as menu items and drops the Cancel row', () => {
      const ref = surfaces.openActions(data(), { anchor: opener });
      tick();

      expect(ref.presentation).toBe('popover');
      const menu = screen.getByRole('menu', { name: 'New message' });
      expect(menu.getAttribute('data-testid')).toBe('action-list-menu');
      expect(
        screen.getAllByRole('menuitem').map((item) => item.textContent?.trim()),
      ).toEqual(['Create a room', 'Archive', 'Leave']);
      expect(screen.queryByTestId('row-cancel')).toBeNull();
      expect(screen.queryByTestId('sheet-handle')).toBeNull();
      expect(ref.surface).toBe(menu);
    });

    it('keeps danger ink, a rule before it, and an inert disabled row', () => {
      surfaces.openActions(data(), { anchor: opener });
      tick();

      const leave = screen.getByTestId('row-leave');
      expect(leave.getAttribute('data-trn-variant')).toBe('danger');
      expect(leave.classList).toContain('text-danger');
      expect(leave.previousElementSibling?.getAttribute('role')).toBe(
        'separator',
      );
      expect(screen.getByTestId('row-archive')).toBeDisabled();
    });

    it('offers the reactions as a compact row that closes the menu', () => {
      const react = vi.fn();
      const closed = vi.fn();
      surfaces
        .openActions(data(vi.fn(), react), { anchor: opener })
        .closed.subscribe(closed);
      tick();

      const row = screen.getByRole('group', { name: 'Quick reactions' });
      screen.getByRole('button', { name: 'React with 👍' }).click();

      expect(row.closest('[role=menu]')).not.toBeNull();
      expect(react).toHaveBeenCalledOnce();
      expect(closed).toHaveBeenCalledOnce();
    });

    it('draws no rule for a card break, only for a separator', () => {
      surfaces.openActions(
        {
          buttons: [
            { text: 'Reply', handler: vi.fn() },
            { text: 'Quote', cardBefore: true, handler: vi.fn() },
          ],
        },
        { anchor: opener },
      );
      tick();

      expect(
        screen.getByRole('menu').querySelectorAll('[role=separator]'),
      ).toHaveLength(0);
    });

    it('keeps a reaction-tile row as a menu item', () => {
      surfaces.openActions(
        {
          buttons: [
            { text: 'More reactions…', reactionTile: true, handler: vi.fn() },
          ],
        },
        { anchor: opener },
      );
      tick();

      expect(
        screen.getByRole('menuitem', { name: 'More reactions…' }),
      ).toBeTruthy();
      expect(screen.queryByTestId('action-sheet-group')).toBeNull();
    });

    it('names each reaction from its visible emoji', () => {
      surfaces.openActions(data(), { anchor: opener });
      tick();

      expectReactionNamedFromItsEmoji();
    });

    it('names the menu from ariaLabel when it has no header', () => {
      surfaces.openActions(
        { buttons: [{ text: 'Reply', handler: vi.fn() }] },
        { anchor: opener, ariaLabel: 'Message actions' },
      );
      tick();

      expect(
        screen.getByRole('menu', { name: 'Message actions' }),
      ).toBeTruthy();
    });

    it('keeps the ariaLabel as the menu name when a header is also shown', () => {
      surfaces.openActions(
        {
          header: 'Today 3:41 PM',
          buttons: [{ text: 'Reply', handler: vi.fn() }],
        },
        { anchor: opener, ariaLabel: 'Message actions' },
      );
      tick();

      expect(
        screen.getByRole('menu', { name: 'Message actions' }),
      ).toBeTruthy();
      expect(screen.getByText('Today 3:41 PM')).toBeTruthy();
    });

    it('lets Tab walk from the reactions into the menu rows and back', () => {
      surfaces.openActions(data(), { anchor: opener });
      tick();
      const menu = screen.getByRole('menu');
      const react = screen.getByRole('button', { name: 'React with 👍' });
      const tabbable = () =>
        Array.from(
          menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
        ).filter((el) => el.tabIndex >= 0);
      // jsdom has no native Tab, so follow the browser's rule: the key must not be
      // cancelled, and focus goes to the next tabbable control in document order.
      const tab = (shift = false) => {
        const from = document.activeElement as HTMLElement;
        const proceeds = fireEvent.keyDown(from, {
          key: 'Tab',
          keyCode: 9,
          shiftKey: shift,
        });
        expect(proceeds).toBe(true);
        const order = tabbable();
        const to =
          order[order.indexOf(from as HTMLButtonElement) + (shift ? -1 : 1)];
        to?.focus();
      };

      react.focus();
      expect(tabbable()).toContain(react);
      tab();
      expect(menu.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(react);
      expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
      tab(true);
      expect(document.activeElement).toBe(react);
      expect(screen.getByRole('menu')).toBe(menu);
    });

    it('moves between rows with the arrow keys and closes, then runs, on a pick', () => {
      const handler = vi.fn();
      surfaces.openActions(data(handler), { anchor: opener });
      tick();
      const menu = screen.getByRole('menu');
      menu.focus();
      expect(document.activeElement).toBe(screen.getByTestId('row-create'));

      fireEvent.keyDown(document.activeElement!, {
        key: 'ArrowDown',
        keyCode: 40,
      });
      // The disabled Archive row is skipped by CDK's key manager only when it is
      // `cdkMenuItemDisabled`; either way focus must leave the first row.
      expect(document.activeElement).not.toBe(screen.getByTestId('row-create'));

      screen.getByTestId('row-create').click();
      tick();
      expect(handler).toHaveBeenCalledOnce();
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes on Escape and returns focus to its button', () => {
      surfaces.openActions(data(), { anchor: opener });
      tick();

      fireEvent.keyDown(screen.getByRole('menu'), {
        key: 'Escape',
        keyCode: 27,
      });
      tick();

      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  });

  describe('as a sheet', () => {
    it.each([
      ['on a mobile OS', () => (platform.mobile = true)],
      ['below md', () => (media.narrow = true)],
    ])('is a sheet %s, even with an anchor', (_, arrange) => {
      arrange();
      const ref = surfaces.openActions(data(), { anchor: opener });
      tick();

      expect(ref.presentation).toBe('sheet');
      expect(screen.getByTestId('action-sheet-surface').tagName).toBe(
        'TRN-SHEET-FRAME',
      );
      expect(screen.getByTestId('sheet-handle')).toBeTruthy();
      expect(screen.getByTestId('row-cancel')).toBeTruthy();
    });

    it('names each reaction from its visible emoji', () => {
      surfaces.openActions(data());
      tick();

      expectReactionNamedFromItsEmoji();
    });

    it('groups the rows into cards at each separator and for Cancel', () => {
      media.narrow = true;
      surfaces.openActions(data());
      tick();

      const cards = screen.getAllByTestId('action-sheet-group');
      expect(
        cards.map((card) =>
          [...card.querySelectorAll('button')].map(
            (row) => row.dataset['testid'],
          ),
        ),
      ).toEqual([['row-create', 'row-archive'], ['row-leave'], ['row-cancel']]);
      // A rule between rows inside a card, inset past the icon column; none after the last.
      const dividers = screen.getAllByTestId('action-sheet-divider');
      expect(dividers).toHaveLength(1);
      expect(dividers[0].parentElement).toBe(cards[0]);
      expect(dividers[0].classList).toContain('ms-14');
      expect(cards[0].lastElementChild).toBe(screen.getByTestId('row-archive'));
      expect(
        screen.getByTestId('row-leave').getAttribute('data-trn-variant'),
      ).toBe('danger');
      expect(screen.getByTestId('row-archive')).toBeDisabled();
    });

    it('marks a row that opens another sheet with a chevron', () => {
      media.narrow = true;
      surfaces.openActions({
        buttons: [
          {
            text: 'Format',
            icon: 'pencil',
            submenu: true,
            testId: 'row-format',
          },
          { text: 'Poll', icon: 'vote', testId: 'row-poll' },
        ],
      });
      tick();

      const chevrons = screen.getAllByTestId('action-sheet-chevron');
      expect(chevrons).toHaveLength(1);
      expect(screen.getByTestId('row-format').contains(chevrons[0])).toBe(true);
    });

    it('shows a reaction-tile row as the last quick-reaction tile, not a row', () => {
      media.narrow = true;
      const more = vi.fn();
      surfaces.openActions({
        reactions: [{ key: '👍', handler: vi.fn() }],
        buttons: [
          {
            text: 'More reactions…',
            icon: 'smile',
            reactionTile: true,
            testId: 'row-more',
            handler: more,
          },
          { text: 'Reply', testId: 'row-reply' },
        ],
      });
      tick();

      const tiles = screen.getByRole('group', { name: 'Quick reactions' });
      const tile = screen.getByRole('button', { name: 'More reactions…' });
      expect(tiles.lastElementChild).toBe(tile);
      expect(screen.getAllByTestId('action-sheet-group')).toHaveLength(1);
      tile.click();
      expect(more).toHaveBeenCalledOnce();
    });

    it('slides in like every other sheet', () => {
      surfaces.openActions(data());
      tick();

      const { classList } = screen.getByTestId('action-sheet-surface');
      expect(classList).toContain('trn-overlay-enter-sheet');
      expect(classList).not.toContain('animate-none');
    });

    it('falls back to a sheet on a coarse pointer even with an anchor', () => {
      media.coarse = true;
      const ref = surfaces.openActions(data(), { anchor: opener });
      tick();

      expect(ref.presentation).toBe('sheet');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(screen.getByTestId('action-sheet-surface')).toBeTruthy();
    });

    it('opens a keyboard-usable sheet on desktop without an anchor', () => {
      const ref = surfaces.openActions(data(), { ariaLabel: 'New' });
      tick();

      expect(ref.presentation).toBe('sheet');
      const dialog = screen.getByRole('dialog', { name: 'New' });
      expect(dialog.contains(document.activeElement)).toBe(true);

      fireEvent.keyDown(document.body, { key: 'Escape', keyCode: 27 });
      tick();

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
    });

    it('keeps the plain rows on a desktop sheet opened without an anchor', () => {
      surfaces.openActions({
        ...data(),
        buttons: [
          ...data().buttons,
          { text: 'More reactions…', reactionTile: true, testId: 'row-more' },
          { text: 'Quote', cardBefore: true, testId: 'row-quote' },
        ],
      });
      tick();

      expect(screen.queryByTestId('action-sheet-group')).toBeNull();
      expect(
        screen
          .getByTestId('row-more')
          .closest('[aria-label="Quick reactions"]'),
      ).toBeNull();
      // Only the separator draws a rule, as before.
      expect(
        screen
          .getByTestId('action-sheet-surface')
          .querySelectorAll('[role=separator]'),
      ).toHaveLength(1);
    });

    it('leaves focus to the opener when it restores it itself', () => {
      surfaces.openActions(data(), { restoreFocus: false });
      tick();
      opener.blur();

      surfaces.closeAll();
      tick();

      expect(document.activeElement).not.toBe(opener);
    });
  });
});
