import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/ui-spartan';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSearchComponent } from './message-search.component';
import { MessageSearchService } from './message-search.service';

describe('MessageSearchService', () => {
  let openAndWait: ReturnType<typeof vi.fn>;
  let svc: MessageSearchService;

  beforeEach(() => {
    openAndWait = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        MessageSearchService,
        { provide: TrnDialogService, useValue: { openAndWait } },
      ],
    });
    svc = TestBed.inject(MessageSearchService);
  });

  it('opens a right-aligned panel scoped to the room and resolves the chosen id', async () => {
    openAndWait.mockResolvedValue('$jump:hs');

    const result = await svc.search('!r:hs');

    expect(openAndWait).toHaveBeenCalledWith(MessageSearchComponent, {
      side: 'end',
      inputs: { roomId: '!r:hs' },
    });
    expect(result).toBe('$jump:hs');
  });

  it('resolves null when dismissed without a selection', async () => {
    openAndWait.mockResolvedValue(null);
    expect(await svc.search('!r:hs')).toBeNull();
  });

  it('ignores a repeat trigger while search is already open', async () => {
    // Controlled pending promise so the first search stays open across the re-entry.
    let release!: (value: string | null) => void;
    const dismissed = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    openAndWait.mockReturnValue(dismissed);

    const first = svc.search('!r:hs'); // opens; stays pending
    const second = await svc.search('!r:hs'); // re-entrant: no second dialog

    expect(second).toBeNull();
    expect(openAndWait).toHaveBeenCalledTimes(1);

    release('$e:hs');
    await expect(first).resolves.toBe('$e:hs');
  });
});
