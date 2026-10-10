import { TestBed } from '@angular/core/testing';
import { TrnToastService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { ShellStatusService } from './shell-status.service';

describe('ShellStatusService', () => {
  it('shows a warning in the warning variant', () => {
    const show = vi.fn();
    TestBed.configureTestingModule({
      providers: [ShellStatusService, MockProvider(TrnToastService, { show })],
    });
    TestBed.inject(ShellStatusService).showWarning('Heads up.');
    expect(show).toHaveBeenCalledWith('Heads up.', {
      duration: 6000,
      variant: 'warning',
    });
  });
});
