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

    it('appears in place, so the message viewport measures its final top', () => {
      surfaces.openActions(data());
      tick();

      expect(screen.getByTestId('action-sheet-surface').classList).toContain(
        'animate-none',
      );
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
