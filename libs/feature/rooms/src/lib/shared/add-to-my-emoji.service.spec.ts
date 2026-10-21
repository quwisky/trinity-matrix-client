import { Component, signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ADD_TO_IMAGE_PACK_DIALOG,
  ImagePackEditorService,
  type PackEntry,
} from '@trinity/data-access/media';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddToMyEmojiService } from './add-to-my-emoji.service';

@Component({ template: '' })
class FakeDialogComponent {
  canDismiss = vi.fn(() => false);
}

describe('AddToMyEmojiService', () => {
  const toast = { show: vi.fn() };
  let load: () => Observable<Type<unknown>>;
  const personal = signal<readonly PackEntry[] | null>([]);
  const activeUserId = signal<string | null>('@a:hs');
  let closes: Subject<PackEntry | null>[];
  const surfaces = {
    openAndWait$: vi.fn(() => {
      const close = new Subject<PackEntry | null>();
      closes.push(close);
      return close;
    }),
  };

  beforeEach(() => {
    closes = [];
    surfaces.openAndWait$.mockClear();
    toast.show.mockReset();
    personal.set([]);
    activeUserId.set('@a:hs');
    load = () => of(FakeDialogComponent);
    TestBed.configureTestingModule({
      providers: [
        { provide: TrnSurfaceService, useValue: surfaces },
        { provide: TrnToastService, useValue: toast },
        { provide: ImagePackEditorService, useValue: { personal } },
        { provide: MatrixClientService, useValue: { activeUserId } },
        {
          provide: ADD_TO_IMAGE_PACK_DIALOG,
          useValue: () => load(),
        },
      ],
    });
  });

  it('Add opens the file chooser, then the dialog for each file in turn', () => {
    const service = TestBed.inject(AddToMyEmojiService);
    const fox = new File(['a'], 'fox.png', { type: 'image/png' });
    const cat = new File(['b'], 'cat.gif', { type: 'image/gif' });

    service.addFiles([fox, cat]);

    expect(surfaces.openAndWait$).toHaveBeenCalledTimes(1);
    expect(surfaces.openAndWait$).toHaveBeenLastCalledWith(
      FakeDialogComponent,
      expect.objectContaining({
        inputs: {
          input: { kind: 'file', file: fox },
          suggestedName: 'fox.png',
        },
        autoFocus: '[data-autofocus]',
      }),
    );
    const options = (
      surfaces.openAndWait$.mock.calls[0] as unknown as [
        unknown,
        { dismissGuard: (d: FakeDialogComponent | null) => boolean },
      ]
    )[1];
    expect(options.dismissGuard(new FakeDialogComponent())).toBe(false);
    expect(options.dismissGuard(null)).toBe(true);

    closes[0].next(null);
    closes[0].complete();

    expect(surfaces.openAndWait$).toHaveBeenCalledTimes(2);
    expect(surfaces.openAndWait$).toHaveBeenLastCalledWith(
      FakeDialogComponent,
      expect.objectContaining({
        inputs: {
          input: { kind: 'file', file: cat },
          suggestedName: 'cat.gif',
        },
      }),
    );
  });

  it('drops the queued files when the account changes', () => {
    const service = TestBed.inject(AddToMyEmojiService);
    const fox = new File(['a'], 'fox.png', { type: 'image/png' });

    service.addFiles([fox, fox, fox]);
    activeUserId.set('@b:hs');
    // The dialog closes itself on the switch.
    closes[0].next(null);
    closes[0].complete();

    expect(surfaces.openAndWait$).toHaveBeenCalledOnce();
    service.addFiles([fox]);
    expect(surfaces.openAndWait$).toHaveBeenCalledTimes(2);
  });

  it('shows the failed-action toast when the dialog cannot load, and can open again', () => {
    const service = TestBed.inject(AddToMyEmojiService);
    load = () => throwError(() => new Error('chunk failed'));

    service.add({ kind: 'existing', url: 'mxc://hs/fox' }, 'fox');

    expect(toast.show).toHaveBeenCalledWith(
      'Couldn’t open Add to your emoji. Try again.',
      { variant: 'danger' },
    );
    load = () => of(FakeDialogComponent);
    service.add({ kind: 'existing', url: 'mxc://hs/fox' }, 'fox');
    expect(surfaces.openAndWait$).toHaveBeenCalledOnce();
  });

  it('opens no second dialog while one is open or queued', () => {
    const service = TestBed.inject(AddToMyEmojiService);
    const fox = new File(['a'], 'fox.png', { type: 'image/png' });

    service.addFiles([fox, fox]);
    service.add({ kind: 'existing', url: 'mxc://hs/cat' }, 'cat');
    service.addFiles([fox]);
    expect(surfaces.openAndWait$).toHaveBeenCalledOnce();

    closes[0].next(null);
    closes[0].complete();
    expect(surfaces.openAndWait$).toHaveBeenCalledTimes(2);
    closes[1].next(null);
    closes[1].complete();

    service.add({ kind: 'existing', url: 'mxc://hs/cat' }, 'cat');
    expect(surfaces.openAndWait$).toHaveBeenCalledTimes(3);
  });

  it('hidden when that mxc is already in the pack', () => {
    const service = TestBed.inject(AddToMyEmojiService);
    expect(service.canAdd('mxc://hs/fox')).toBe(true);

    personal.set([
      { shortcode: 'fox', url: 'mxc://hs/fox', usage: ['emoticon'] },
    ]);

    expect(service.canAdd('mxc://hs/fox')).toBe(false);
    expect(service.canAdd('mxc://hs/cat')).toBe(true);
  });

  it('offers nothing before the pack is known', () => {
    personal.set(null);

    const service = TestBed.inject(AddToMyEmojiService);

    expect(service.available()).toBe(false);
    expect(service.canAdd('mxc://hs/fox')).toBe(false);
  });
});

describe('AddToMyEmojiService without the dialog', () => {
  it('offers nothing in a host that does not provide it', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: TrnSurfaceService, useValue: {} },
        { provide: TrnToastService, useValue: {} },
      ],
    });
    const service = TestBed.inject(AddToMyEmojiService);

    expect(service.available()).toBe(false);
    expect(service.canAdd('mxc://hs/fox')).toBe(false);
  });
});
