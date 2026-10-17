import { DIAGNOSTIC_REPORT_CONFIG } from '@trinity/data-access/diagnostic-log';
import { TrnDialogRef } from '@trinity/components/overlay';
import type { ReleaseNote } from '@trinity/data-access/whats-new';
import { ExternalBrowserService } from '@trinity/platform-native';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { WhatsNewDialogComponent } from './whats-new-dialog.component';

const RELEASES: readonly ReleaseNote[] = [
  {
    version: '0.5.0-next.3',
    date: '2026-10-14',
    sections: { added: ['<b>bold</b>'], fixed: ['Stop the room list jumping'] },
  },
  {
    version: '0.5.0-next.2',
    date: '2026-10-01',
    sections: { changed: ['Faster timeline'] },
  },
];

async function setup(
  releases: readonly ReleaseNote[] = RELEASES,
  issueRepositoryUrl:
    string | null = 'https://github.com/quwisky/trinity-matrix-client',
) {
  const open = vi.fn(() => of(true));
  const close = vi.fn();
  const rendered = await render(WhatsNewDialogComponent, {
    inputs: { releases },
    providers: [
      MockProvider(ExternalBrowserService, { open }),
      MockProvider(TrnDialogRef, { close }),
      { provide: DIAGNOSTIC_REPORT_CONFIG, useValue: { issueRepositoryUrl } },
    ],
  });
  return { ...rendered, open, close };
}

describe('WhatsNewDialogComponent', () => {
  it('renders each release newest first with its version heading', async () => {
    await setup();

    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent?.trim());
    expect(headings).toEqual([
      'v0.5.0-next.3 · Oct 14, 2026',
      'v0.5.0-next.2 · Oct 1, 2026',
    ]);
  });

  it('hides empty sections', async () => {
    await setup();

    const sections = screen
      .getAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent?.trim());
    expect(sections).toEqual(['Added', 'Fixed', 'Changed']);
  });

  it('renders entries as plain text', async () => {
    const { container } = await setup();

    expect(screen.getByText('<b>bold</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
  });

  it('closes on Close', async () => {
    const { close } = await setup();

    screen.getByRole('button', { name: 'Close' }).click();

    expect(close).toHaveBeenCalledOnce();
  });

  it('opens the newest release page', async () => {
    const { open } = await setup();

    screen.getByRole('button', { name: 'Full release notes' }).click();

    expect(open).toHaveBeenCalledWith(
      'https://github.com/quwisky/trinity-matrix-client/releases/tag/v0.5.0-next.3',
    );
  });

  it('hides the release page link without a repository', async () => {
    await setup(RELEASES, null);

    expect(
      screen.queryByRole('button', { name: 'Full release notes' }),
    ).toBeNull();
  });
});
