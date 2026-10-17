import { TestBed } from '@angular/core/testing';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { UserPickerService } from './user-picker.service';

describe('UserPickerService', () => {
  it('starts focus on the search field rather than the close button', () => {
    const openAndWait$ = vi.fn(() => of(null));
    TestBed.configureTestingModule({
      providers: [MockProvider(TrnSurfaceService, { openAndWait$ })],
    });

    TestBed.inject(UserPickerService)
      .pick$({ title: 'Find', confirmLabel: 'Select' })
      .subscribe();

    expect(openAndWait$).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoFocus: '[data-autofocus]' }),
    );
  });

  it('resolves just the user ID from pick$, and the name too from pickUser$', async () => {
    const openAndWait$ = vi.fn(() =>
      of({ userId: '@bob:hs', displayName: 'Bob' }),
    );
    TestBed.configureTestingModule({
      providers: [
        MockProvider(TrnSurfaceService, {
          openAndWait$: openAndWait$ as never,
        }),
      ],
    });
    const picker = TestBed.inject(UserPickerService);
    const options = { title: 'Find', confirmLabel: 'Select' };

    await expect(firstValueFrom(picker.pick$(options))).resolves.toBe(
      '@bob:hs',
    );
    await expect(firstValueFrom(picker.pickUser$(options))).resolves.toEqual({
      userId: '@bob:hs',
      displayName: 'Bob',
    });
  });
});
