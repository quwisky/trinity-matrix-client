import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  ADD_TO_IMAGE_PACK_DIALOG,
  ImagePackEditorService,
  type PackEntry,
} from '@trinity/data-access/media';
import { Subject, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddToMyEmojiService } from './add-to-my-emoji.service';

@Component({ template: '' })
class FakeDialogComponent {
  canDismiss = vi.fn(() => false);
}

describe('AddToMyEmojiService', () => {
  const personal = signal<readonly PackEntry[] | null>([]);
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
    personal.set([]);
    TestBed.configureTestingModule({
      providers: [
        { provide: TrnSurfaceService, useValue: surfaces },
        { provide: ImagePackEditorService, useValue: { personal } },
        {
          provide: ADD_TO_IMAGE_PACK_DIALOG,
          useValue: () => of(FakeDialogComponent),
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
      providers: [{ provide: TrnSurfaceService, useValue: {} }],
    });
    const service = TestBed.inject(AddToMyEmojiService);

    expect(service.available()).toBe(false);
    expect(service.canAdd('mxc://hs/fox')).toBe(false);
  });
});
