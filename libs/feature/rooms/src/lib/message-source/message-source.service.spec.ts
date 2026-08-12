import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '@trinity/kit/overlay';
import { TimelineService } from '@trinity/data-access/timeline';
import { MessageSourceService } from './message-source.service';
import { MessageSourceComponent } from './message-source.component';

function setup(raw: object | null) {
  const rawEvent = vi.fn(() => raw);
  const open = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      MessageSourceService,
      MockProvider(TimelineService, { rawEvent }),
      MockProvider(TrnDialogService, { open }),
    ],
  });
  return { svc: TestBed.inject(MessageSourceService), rawEvent, open };
}

describe('MessageSourceService', () => {
  it('opens the dialog with the event JSON, pretty-printed', () => {
    const { svc, rawEvent, open } = setup({ type: 'm.room.message', a: 1 });

    svc.open('!r:hs', '$e');

    expect(rawEvent).toHaveBeenCalledWith('!r:hs', '$e');
    expect(open).toHaveBeenCalledWith(
      MessageSourceComponent,
      expect.objectContaining({
        inputs: {
          source: JSON.stringify({ type: 'm.room.message', a: 1 }, null, 2),
        },
      }),
    );
  });

  it('is a no-op when the event is not loaded', () => {
    const { svc, open } = setup(null);

    svc.open('!r:hs', '$missing');

    expect(open).not.toHaveBeenCalled();
  });
});
