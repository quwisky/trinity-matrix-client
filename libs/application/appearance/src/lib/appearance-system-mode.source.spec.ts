import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { BrowserAppearanceSystemModeSource } from './appearance-system-mode.source';

interface FakeMediaQueryList {
  matches: boolean;
  addEventListener: Mock;
  removeEventListener: Mock;
  fire: () => void;
}

function mediaQuery(matches: boolean): FakeMediaQueryList {
  let listener: (() => void) | undefined;
  return {
    matches,
    addEventListener: vi.fn((_event: string, next: () => void) => {
      listener = next;
    }),
    removeEventListener: vi.fn(),
    fire: () => listener?.(),
  };
}

describe('BrowserAppearanceSystemModeSource', () => {
  it('owns the media listener for exactly one subscription lifetime', () => {
    const media = mediaQuery(false);
    const fakeDocument = {
      defaultView: {
        matchMedia: vi.fn(() => media as unknown as MediaQueryList),
      },
    } as unknown as Document;
    TestBed.configureTestingModule({
      providers: [
        BrowserAppearanceSystemModeSource,
        { provide: DOCUMENT, useValue: fakeDocument },
      ],
    });
    const source = TestBed.inject(BrowserAppearanceSystemModeSource);
    const values: string[] = [];

    const subscription = source
      .observe()
      .subscribe((value) => values.push(value));
    media.matches = true;
    media.fire();

    expect(values).toEqual(['light', 'dark']);
    expect(media.addEventListener).toHaveBeenCalledOnce();

    subscription.unsubscribe();
    expect(media.removeEventListener).toHaveBeenCalledOnce();
  });
});
