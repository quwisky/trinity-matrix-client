import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { HOST_BADGE_OPERATION, HostBadgeService } from './host-badge.service';

describe('HostBadgeService', () => {
  it('reports unavailable when composition supplied no badge adapter', async () => {
    const badge = TestBed.inject(HostBadgeService);

    await expect(firstValueFrom(badge.support())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-implemented',
    });
    await expect(firstValueFrom(badge.set(3))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-implemented',
    });
  });

  it('keeps commands cold, clamps counts, and returns the adapter outcome', async () => {
    const set = vi.fn(() => of({ kind: 'completed' } as const));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_BADGE_OPERATION,
          useValue: {
            support: () => of({ kind: 'supported' } as const),
            set,
          },
        },
      ],
    });
    const command = TestBed.inject(HostBadgeService).set(20_000.9);

    expect(set).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'completed',
    });
    expect(set).toHaveBeenCalledWith(9999);
  });
});
