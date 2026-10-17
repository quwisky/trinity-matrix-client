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

describe('MessageActionSheetService', () => {
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
    const caps = {} as Parameters<MessageActionSheetService['open']>[1];

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
