import { render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { SaveFailureComponent } from './save-failure.component';

describe('SaveFailureComponent', () => {
  it('announces that the choice could not be saved', async () => {
    await render(SaveFailureComponent);

    expect(screen.getByRole('alert').textContent).toContain(
      'This choice could not be saved.',
    );
  });

  it('emits retry from a button carrying the caller test id', async () => {
    const retry = vi.fn();
    await render(SaveFailureComponent, {
      inputs: { retryTestId: 'x-retry' },
      on: { retry },
    });

    screen.getByTestId('x-retry').click();

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('omits the button when the failure cannot be retried', async () => {
    await render(SaveFailureComponent, { inputs: { retryable: false } });

    expect(screen.queryByRole('button')).toBeNull();
  });
});
