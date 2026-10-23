import { TestBed } from '@angular/core/testing';
import {
  TrnSurfaceService,
  type ActionSheetReaction,
} from '@trinity/components/overlay';
import { RecentEmojiService } from '@trinity/data-access/media';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MessageActionSheetService } from './message-action-sheet.service';

type SheetCaps = Parameters<MessageActionSheetService['open']>[1];

describe('MessageActionSheetService', () => {
  it('offers Forward only when the message can be forwarded', () => {
    let testIds: (string | undefined)[] = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(RecentEmojiService, { record: vi.fn() }),
        MockProvider(TrnSurfaceService, {
          openActions: vi.fn(
            (options: { buttons: readonly { testId?: string }[] }) => {
              testIds = options.buttons.map((b) => b.testId);
              return {
                presentation: 'menu',
                closed: new Subject<void>(),
                close: vi.fn(),
              } as never;
            },
          ),
        }),
      ],
    });
    const sheet = TestBed.inject(MessageActionSheetService);

    sheet.open({}, { canForward: false } as SheetCaps, vi.fn());
    expect(testIds).toContain('sheet-copy');
    expect(testIds).not.toContain('sheet-forward');

    sheet.open({}, { canForward: true } as SheetCaps, vi.fn());
    expect(testIds).toContain('sheet-forward');
    expect(testIds).not.toContain('sheet-add-to-emoji');

    sheet.open({}, { addToEmoji: true } as SheetCaps, vi.fn());
    expect(testIds).toContain('sheet-add-to-emoji');
  });

  it('offers no reply or reaction on an unsent message', () => {
    let testIds: (string | undefined)[] = [];
    let reactions: readonly ActionSheetReaction[] = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(RecentEmojiService, { record: vi.fn() }),
        MockProvider(TrnSurfaceService, {
          openActions: vi.fn(
            (options: {
              buttons: readonly { testId?: string }[];
              reactions?: readonly ActionSheetReaction[];
            }) => {
              testIds = options.buttons.map((b) => b.testId);
              reactions = options.reactions ?? [];
              return {
                presentation: 'menu',
                closed: new Subject<void>(),
                close: vi.fn(),
              } as never;
            },
          ),
        }),
      ],
    });
    const sheet = TestBed.inject(MessageActionSheetService);

    sheet.open({}, { canRespond: false } as SheetCaps, vi.fn());
    expect(testIds).not.toContain('sheet-reply');
    expect(testIds).not.toContain('sheet-react-more');
    expect(reactions).toEqual([]);
    expect(testIds).toContain('sheet-copy');

    sheet.open({}, { canRespond: true } as SheetCaps, vi.fn());
    expect(testIds).toContain('sheet-reply');
    expect(testIds).toContain('sheet-react-more');
    expect(reactions.length).toBeGreaterThan(0);
  });

  it('records a reaction picked from the sheet as a recently used emoji', () => {
    const record = vi.fn();
    let reactions: readonly ActionSheetReaction[] = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(RecentEmojiService, { record }),
        MockProvider(TrnSurfaceService, {
          openActions: vi.fn(
            (options: { reactions?: readonly ActionSheetReaction[] }) => {
              reactions = options.reactions ?? [];
              return {
                presentation: 'menu',
                closed: new Subject<void>(),
                close: vi.fn(),
              } as never;
            },
          ),
        }),
      ],
    });
    const dispatch = vi.fn();
    const caps = { canRespond: true } as SheetCaps;

    TestBed.inject(MessageActionSheetService).open({}, caps, dispatch);
    const reaction = reactions[0];
    reaction?.handler();

    expect(record).toHaveBeenCalledWith(reaction?.key);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'react',
      key: reaction?.key,
    });
  });
});
