import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '@trinity/helm/overlay';
import { UserCardService } from './user-card.service';
import { UserCardComponent } from './user-card.component';

function setup(result: string | null) {
  const openAndWait = vi.fn().mockResolvedValue(result);
  TestBed.configureTestingModule({
    providers: [
      UserCardService,
      MockProvider(TrnDialogService, { openAndWait }),
    ],
  });
  return { svc: TestBed.inject(UserCardService), openAndWait };
}

describe('UserCardService', () => {
  it('opens the card for the user and resolves the id to message', async () => {
    const { svc, openAndWait } = setup('@bob:hs');
    const chosen = await svc.open('@bob:hs');
    expect(openAndWait).toHaveBeenCalledWith(UserCardComponent, {
      ariaLabel: 'User',
      inputs: { userId: '@bob:hs' },
    });
    expect(chosen).toBe('@bob:hs');
  });

  it('resolves null when the card is dismissed', async () => {
    const { svc } = setup(null);
    expect(await svc.open('@bob:hs')).toBeNull();
  });
});
