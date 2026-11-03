import { TestBed } from '@angular/core/testing';
import {
  TrnSurfaceService,
  type ActionSheetReaction,
} from '@trinity/components/overlay';
import { RecentEmojiService } from '@trinity/data-access/media';
import {
  DateTimeFormatService,
  HapticsService,
} from '@trinity/platform-native';
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

  it('gives one haptic per press that opens the sheet', () => {
    const gestureCommitted = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        MockProvider(RecentEmojiService, { record: vi.fn() }),
        MockProvider(HapticsService, { gestureCommitted }),
        MockProvider(TrnSurfaceService, {
          openActions: vi.fn(
            () =>
              ({
                presentation: 'sheet',
                closed: new Subject<void>(),
                close: vi.fn(),
              }) as never,
          ),
        }),
      ],
    });
    const sheet = TestBed.inject(MessageActionSheetService);

    sheet.open({}, {} as SheetCaps, vi.fn());
    expect(gestureCommitted).toHaveBeenCalledOnce();

    sheet.open({}, {} as SheetCaps, vi.fn());
    expect(gestureCommitted).toHaveBeenCalledTimes(2);
  });

  it('puts Edit and Delete ahead of the rarely used actions, and never offers Report on your own message', () => {
    let testIds: (string | undefined)[] = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(RecentEmojiService, { record: vi.fn() }),
        MockProvider(TrnSurfaceService, {
          openActions: vi.fn(
            (options: { buttons: readonly { testId?: string }[] }) => {
              testIds = options.buttons.map((b) => b.testId);
              return {
                presentation: 'sheet',
                closed: new Subject<void>(),
                close: vi.fn(),
              } as never;
            },
          ),
        }),
      ],
    });
    const sheet = TestBed.inject(MessageActionSheetService);

    sheet.open(
      {},
      {
        editable: true,
        deletable: true,
        canQuote: true,
        canPin: true,
        isOwn: true,
      } as SheetCaps,
      vi.fn(),
    );
    expect(testIds).not.toContain('sheet-report');
    for (const early of ['sheet-edit', 'sheet-delete']) {
      expect(testIds.indexOf(early)).toBeLessThan(
        testIds.indexOf('sheet-copy'),
      );
    }

    sheet.open({}, { isOwn: false } as SheetCaps, vi.fn());
    expect(testIds).toContain('sheet-report');
  });

  // A grouped message shows its time only on hover, which a touch screen never has.
  it('headlines the sheet with the message time, and leaves a timeless message bare', () => {
    const headers: (string | undefined)[] = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(RecentEmojiService, { record: vi.fn() }),
        MockProvider(DateTimeFormatService, {
          dateTime: vi.fn((ts: number) => `time ${ts}`),
        }),
        MockProvider(TrnSurfaceService, {
          openActions: vi.fn((options: { header?: string }) => {
            headers.push(options.header);
            return {
              presentation: 'sheet',
              closed: new Subject<void>(),
              close: vi.fn(),
            } as never;
          }),
        }),
      ],
    });
    const sheet = TestBed.inject(MessageActionSheetService);

    sheet.open({}, {} as SheetCaps, vi.fn(), undefined, 1_700_000_000_000);
    sheet.open({}, {} as SheetCaps, vi.fn(), undefined, 0);
    sheet.open({}, {} as SheetCaps, vi.fn());

    expect(headers).toEqual(['time 1700000000000', undefined, undefined]);
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

  it('groups the replies apart from the rest, and makes More reactions a tile', () => {
    let buttons: readonly {
      testId?: string;
      separatorBefore?: boolean;
      reactionTile?: boolean;
    }[] = [];
    TestBed.configureTestingModule({
      providers: [
        MockProvider(RecentEmojiService, { record: vi.fn() }),
        MockProvider(TrnSurfaceService, {
          openActions: vi.fn((options: { buttons: typeof buttons }) => {
            buttons = options.buttons;
            return {
              presentation: 'sheet',
              closed: new Subject<void>(),
              close: vi.fn(),
            } as never;
          }),
        }),
      ],
    });
    const sheet = TestBed.inject(MessageActionSheetService);
    const starts = () =>
      buttons.filter((b) => b.separatorBefore).map((b) => b.testId);

    sheet.open({}, { canRespond: true, canQuote: true } as SheetCaps, vi.fn());
    expect(starts()).toEqual(['sheet-quote']);
    expect(buttons.filter((b) => b.reactionTile).map((b) => b.testId)).toEqual([
      'sheet-react-more',
    ]);

    sheet.open(
      {},
      { canRespond: true, editable: true, deletable: true } as SheetCaps,
      vi.fn(),
    );
    expect(starts()).toEqual(['sheet-delete']);

    // Nothing above the rest, so no group to rule off.
    sheet.open({}, { canRespond: false } as SheetCaps, vi.fn());
    expect(starts()).toEqual([]);
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
