import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnActionSheetService } from '../action-sheet/trn-action-sheet.service';
import { TrnDialogService } from '../dialog/trn-dialog.service';
import { TrnSurfaceService } from './trn-surface.service';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

@Component({ template: '<p>Surface</p>' })
class PlainComponent {}

const media = { narrow: false, coarse: false };

function stubMedia(): void {
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
}

function anchor(): HTMLElement {
  const element = document.createElement('button');
  element.textContent = 'More';
  document.body.append(element);
  return element;
}

describe('TrnSurfaceService', () => {
  let surfaces: TrnSurfaceService;
  const tick = () => TestBed.inject(ApplicationRef).tick();

  beforeEach(() => {
    stubMedia();
    surfaces = TestBed.inject(TrnSurfaceService);
  });

  afterEach(() => {
    surfaces.closeAll();
    platform.mobile = false;
    media.narrow = false;
    media.coarse = false;
    document.querySelectorAll('body > button').forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  it.each([
    [false, false, 'dialog'],
    [false, true, 'sheet'],
    [true, false, 'sheet'],
    [true, true, 'sheet'],
  ] as const)(
    'opens a mobile OS %s, narrow %s surface as a %s',
    (mobile, narrow, expected) => {
      platform.mobile = mobile;
      media.narrow = narrow;

      const ref = surfaces.open(PlainComponent);
      tick();

      expect(ref.presentation).toBe(expected);
    },
  );

  it.each([
    ['fullscreen', 'fullscreen'],
    ['panel', 'inline-end'],
  ] as const)('passes the explicit %s kind through', (kind, placement) => {
    platform.mobile = true;
    const open = vi.spyOn(TestBed.inject(TrnDialogService), 'open');

    surfaces.open(PlainComponent, { kind, ariaLabel: 'Probe' });

    expect(open).toHaveBeenCalledWith(PlainComponent, {
      ariaLabel: 'Probe',
      placement,
    });
  });

  it('anchors a popover on a fine pointer', () => {
    const ref = surfaces.open(PlainComponent, {
      kind: 'popover',
      anchor: anchor(),
    });
    tick();

    expect(ref.presentation).toBe('popover');
  });

  it('applies the rule to a popover without an anchor or on a coarse pointer', () => {
    media.coarse = true;
    media.narrow = true;

    const touch = surfaces.open(PlainComponent, {
      kind: 'popover',
      anchor: anchor(),
    });
    const bare = surfaces.open(PlainComponent, { kind: 'popover' });

    expect(touch.presentation).toBe('sheet');
    expect(bare.presentation).toBe('sheet');
  });

  it('fixes the presentation at open and re-applies the rule on the next open', () => {
    media.narrow = true;
    const first = surfaces.open(PlainComponent);
    tick();

    media.narrow = false;
    tick();
    const second = surfaces.open(PlainComponent);

    expect(first.presentation).toBe('sheet');
    expect(second.presentation).toBe('dialog');
  });

  it('delegates the stack helpers unchanged', () => {
    const dialogs = TestBed.inject(TrnDialogService);
    const ref = surfaces.open(PlainComponent);
    tick();

    expect(surfaces.openState).toBe(dialogs.openState);
    expect(surfaces.hasOpen()).toBe(true);
    expect(surfaces.isTopmost(ref)).toBe(true);
    expect(surfaces.closeTopmost()).toBe(true);
    expect(surfaces.hasOpen()).toBe(false);
  });

  it('resolves openAndWait$ with null on a bare dismissal', async () => {
    const result = firstValueFrom(surfaces.openAndWait$(PlainComponent));
    tick();
    surfaces.closeAll();

    await expect(result).resolves.toBeNull();
  });

  it('hands an action list to the action sheet, anchored only where a menu fits', () => {
    const open = vi.spyOn(TestBed.inject(TrnActionSheetService), 'open');
    const data = { header: 'New message', buttons: [{ text: 'Create' }] };
    const button = anchor();

    surfaces.openActions(data, { ariaLabel: 'New', restoreFocus: false });
    surfaces.openActions(data, { anchor: button });
    platform.mobile = true;
    surfaces.openActions(data, { anchor: button });

    expect(open.mock.calls.map((call) => call[2])).toEqual([
      { restoreFocus: false, anchor: undefined },
      { restoreFocus: undefined, anchor: button },
      { restoreFocus: undefined, anchor: undefined },
    ]);
  });
});
