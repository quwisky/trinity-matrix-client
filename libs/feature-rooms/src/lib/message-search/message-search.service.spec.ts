import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/helm/overlay';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSearchComponent } from './message-search.component';
import { MessageSearchService } from './message-search.service';

describe('MessageSearchService', () => {
  let dialog: TrnDialogService;
  let svc: MessageSearchService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MessageSearchService, MockProvider(TrnDialogService)],
    });
    svc = TestBed.inject(MessageSearchService);
    dialog = TestBed.inject(TrnDialogService);
  });

  it('opens a right-aligned panel scoped to the room and resolves the chosen id', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue('$jump:hs');

    const result = await svc.search('!r:hs');

    expect(dialog.openAndWait).toHaveBeenCalledWith(MessageSearchComponent, {
      ariaLabel: 'Search messages',
      side: 'end',
      inputs: { roomId: '!r:hs' },
    });
    expect(result).toBe('$jump:hs');
  });

  it('resolves null when dismissed without a selection', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue(null);
    expect(await svc.search('!r:hs')).toBeNull();
  });

  it('ignores a repeat trigger while search is already open', async () => {
    // Controlled pending promise so the first search stays open across the re-entry.
    let release!: (value: string | null) => void;
    const dismissed = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    vi.mocked(dialog.openAndWait).mockReturnValue(dismissed);

    const first = svc.search('!r:hs'); // opens; stays pending
    const second = await svc.search('!r:hs'); // re-entrant: no second dialog

    expect(second).toBeNull();
    expect(dialog.openAndWait).toHaveBeenCalledTimes(1);

    release('$e:hs');
    await expect(first).resolves.toBe('$e:hs');
  });
});
