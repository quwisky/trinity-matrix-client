import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { UserPickerService } from './user-picker.service';

describe('UserPickerService', () => {
  it('starts focus on the search field rather than the close button', () => {
    const openAndWait$ = vi.fn(() => of(null));
    TestBed.configureTestingModule({
      providers: [MockProvider(TrnDialogService, { openAndWait$ })],
    });

    TestBed.inject(UserPickerService)
      .pick$({ title: 'Find', confirmLabel: 'Select' })
      .subscribe();

    expect(openAndWait$).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoFocus: '[data-autofocus]' }),
    );
  });
});
