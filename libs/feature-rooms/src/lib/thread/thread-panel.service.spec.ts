import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/helm/overlay';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanelService } from './thread-panel.service';
import { ThreadViewComponent } from './thread-view.component';
import { ThreadsListComponent } from './threads-list.component';

describe('ThreadPanelService', () => {
  let open: ReturnType<typeof vi.fn>;
  let openAndWait: ReturnType<typeof vi.fn>;
  let svc: ThreadPanelService;

  beforeEach(() => {
    open = vi.fn();
    openAndWait = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        ThreadPanelService,
        { provide: TrnDialogService, useValue: { open, openAndWait } },
      ],
    });
    svc = TestBed.inject(ThreadPanelService);
  });

  it('opens the thread view as an end-aligned panel scoped to the room + root', async () => {
    await svc.open('!r:hs', '$root');

    expect(open).toHaveBeenCalledWith(ThreadViewComponent, {
      side: 'end',
      inputs: { roomId: '!r:hs', rootEventId: '$root' },
    });
  });

  it('opens the chosen thread after the list resolves a root id', async () => {
    openAndWait.mockResolvedValue('$picked');

    await svc.openList('!r:hs');

    expect(openAndWait).toHaveBeenCalledWith(ThreadsListComponent, {
      side: 'end',
      inputs: { roomId: '!r:hs' },
    });
    // The resolved root id re-opens as a thread view (the two never stack).
    expect(open).toHaveBeenCalledWith(ThreadViewComponent, {
      side: 'end',
      inputs: { roomId: '!r:hs', rootEventId: '$picked' },
    });
  });

  it('opens nothing when the list is dismissed without a selection', async () => {
    openAndWait.mockResolvedValue(null);

    await svc.openList('!r:hs');

    expect(open).not.toHaveBeenCalled();
  });
});
