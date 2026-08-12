import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/kit/overlay';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanelService } from './thread-panel.service';
import { ThreadViewComponent } from './thread-view.component';
import { ThreadsListComponent } from './threads-list.component';

describe('ThreadPanelService', () => {
  let dialog: TrnDialogService;
  let svc: ThreadPanelService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ThreadPanelService, MockProvider(TrnDialogService)],
    });
    dialog = TestBed.inject(TrnDialogService);
    svc = TestBed.inject(ThreadPanelService);
  });

  it('opens the thread view as an end-aligned panel scoped to the room + root', async () => {
    await svc.open('!r:hs', '$root');

    expect(dialog.open).toHaveBeenCalledWith(ThreadViewComponent, {
      ariaLabel: 'Thread',
      side: 'end',
      inputs: { roomId: '!r:hs', rootEventId: '$root' },
    });
  });

  it('opens the chosen thread after the list resolves a root id', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue('$picked');

    await svc.openList('!r:hs');

    expect(dialog.openAndWait).toHaveBeenCalledWith(ThreadsListComponent, {
      side: 'end',
      inputs: { roomId: '!r:hs' },
    });
    // The resolved root id re-opens as a thread view (the two never stack).
    expect(dialog.open).toHaveBeenCalledWith(ThreadViewComponent, {
      ariaLabel: 'Thread',
      side: 'end',
      inputs: { roomId: '!r:hs', rootEventId: '$picked' },
    });
  });

  it('opens nothing when the list is dismissed without a selection', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue(null);

    await svc.openList('!r:hs');

    expect(dialog.open).not.toHaveBeenCalled();
  });
});
