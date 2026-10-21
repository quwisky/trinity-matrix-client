import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type TrnEmojiIndex } from '@trinity/components/controls';
import { describe, expect, it } from 'vitest';
import { AddToMyEmojiService } from '../shared/add-to-my-emoji.service';
import { EmojiAutocomplete } from './emoji-autocomplete';

const index = {
  nativeFor: (code: string) => ({ smile: '😄', tada: '🎉' })[code] ?? null,
  suggest: () => [],
} as unknown as TrnEmojiIndex;

function autocomplete(): EmojiAutocomplete {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AddToMyEmojiService,
        useValue: {
          emoticons: signal(new Map([['smile', 'mxc://hs/smile']])),
        },
      },
    ],
  });
  return TestBed.runInInjectionContext(() => new EmojiAutocomplete(index));
}

describe('EmojiAutocomplete', () => {
  it('leaves a personal :smile: as text after sync()', () => {
    expect(autocomplete().sync('hi :smile:', 10)).toBeNull();
  });

  it('still converts a Unicode shortcode the personal pack lacks', () => {
    expect(autocomplete().sync('hi :tada:', 9)).toEqual({
      start: 3,
      end: 9,
      insert: '🎉',
    });
  });
});
