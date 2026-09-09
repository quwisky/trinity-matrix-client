import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { SettingsLoadStateCardComponent } from './settings-load-state-card.component';

describe('SettingsLoadStateCardComponent', () => {
  it.each(['loading', 'unavailable'] as const)(
    'announces %s without offering retry',
    async (state) => {
      const { getByRole, queryByRole } = await render(
        SettingsLoadStateCardComponent,
        {
          inputs: {
            state,
            heading: 'Preference status',
            description: 'Read status.',
          },
        },
      );
      const card = getByRole(state === 'loading' ? 'status' : 'alert');
      expect(card.textContent).toContain('Preference status');
      expect(card.textContent).toContain('Read status.');
      expect(card.getAttribute('aria-live')).toBe(
        state === 'loading' ? 'polite' : null,
      );
      expect(queryByRole('button')).toBeNull();
    },
  );

  it('emits retry and updates the announcement when loading resumes', async () => {
    const { fixture, getByRole, queryByRole } = await render(
      SettingsLoadStateCardComponent,
      {
        inputs: {
          state: 'failed',
          heading: 'Couldn’t read Room preferences',
          description: 'Try again.',
          retryTestid: 'room-settings-for-you-retry',
        },
      },
    );
    const retry = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    const button = getByRole('button', { name: 'Try again' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('data-testid')).toBe(
      'room-settings-for-you-retry',
    );
    expect(getByRole('alert').contains(button)).toBe(true);
    button.click();
    expect(retry).toHaveBeenCalledOnce();

    fixture.componentRef.setInput('state', 'loading');
    fixture.componentRef.setInput('heading', 'Reading preferences…');
    fixture.detectChanges();
    expect(getByRole('status').textContent).toContain('Reading preferences…');
    expect(queryByRole('alert')).toBeNull();
    expect(queryByRole('button')).toBeNull();
  });
});
