import { TrnSurfaceService } from '@trinity/components/overlay';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { ReportBugDialogComponent } from '../report-bug/report-bug-dialog.component';
import { ReportBugGroupComponent } from './report-bug-group.component';

describe('ReportBugGroupComponent', () => {
  it('opens the report dialog from Report a bug, and offers nothing about logs', async () => {
    const open = vi.fn();
    await render(ReportBugGroupComponent, {
      providers: [MockProvider(TrnSurfaceService, { open })],
    });

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(/log/i)).toBeNull();
    screen.getByRole('button', { name: 'Report a bug' }).click();

    expect(open).toHaveBeenCalledWith(ReportBugDialogComponent, {
      ariaLabel: 'Report a bug',
      autoFocus: '[data-autofocus]',
    });
  });
});
