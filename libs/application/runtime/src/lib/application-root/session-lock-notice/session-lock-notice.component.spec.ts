import { render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { SessionLockNoticeComponent } from './session-lock-notice.component';
import type { SessionLockNotice } from './session-lock-notice.model';

async function renderNotice(notice: SessionLockNotice) {
  const useHere = vi.fn();
  const showStatus = vi.fn();
  const rendered = await render(SessionLockNoticeComponent, {
    inputs: { notice },
    on: { useHere, showStatus },
  });
  return { ...rendered, useHere, showStatus };
}

describe('SessionLockNoticeComponent', () => {
  it('tells a waiting tab that Trinity runs in another tab and offers to move it here', async () => {
    const { useHere } = await renderNotice('waiting');

    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Trinity is open in another tab',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Trinity runs in one tab at a time so your encrypted messages stay readable. You can move it to this tab.',
      ),
    ).toBeInTheDocument();
    const status = screen.getByTestId('session-lock-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.textContent?.trim()).toBe('');
    const button = screen.getByRole('button', { name: 'Use here' });
    expect(button).not.toHaveAttribute('aria-disabled');

    button.click();

    expect(useHere).toHaveBeenCalledOnce();
  });

  it('announces the move in the live region and keeps the button from sending again', async () => {
    const { useHere } = await renderNotice('taking-over');

    const status = screen.getByTestId('session-lock-status');
    expect(status).toHaveTextContent('Moving Trinity to this tab…');
    expect(status.querySelector('trn-spinner')).not.toBeNull();
    const button = screen.getByRole('button', { name: 'Use here' });
    expect(button).toHaveAttribute('aria-disabled', 'true');

    button.click();

    expect(useHere).not.toHaveBeenCalled();
  });

  it('announces that the other tab did not respond and that the button is now "Try again"', async () => {
    const { useHere } = await renderNotice('handover-timed-out');

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Trinity is open in another tab',
      }),
    ).toBeInTheDocument();
    const status = screen.getByTestId('session-lock-status');
    expect(status).toHaveTextContent(
      'The other tab didn’t respond. It may be asleep or busy.',
    );
    expect(status).toHaveTextContent('Choose Try again to ask again.');
    expect(status.querySelector('trn-spinner')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use here' })).toBeNull();

    screen.getByRole('button', { name: 'Try again' }).click();

    expect(useHere).toHaveBeenCalledOnce();
  });

  it('asks for a secure connection with only System status, never a way to start', async () => {
    const { showStatus, useHere } = await renderNotice('unavailable');

    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Trinity needs a secure connection',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Open Trinity over HTTPS to use it in this browser.'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('button').map((button) => button.textContent?.trim()),
    ).toEqual(['System status']);

    screen.getByRole('button', { name: 'System status' }).click();

    expect(showStatus).toHaveBeenCalledOnce();
    expect(useHere).not.toHaveBeenCalled();
  });
});
