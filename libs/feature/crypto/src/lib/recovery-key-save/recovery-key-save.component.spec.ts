import { render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryKeySaveComponent } from './recovery-key-save.component';

const KEY = 'EsTa bcde fghi jklm nopq rstu vwxy z012 3456 789a bcde fghi';

const inputs = {
  recoveryKey: KEY,
  heading: 'Save your recovery key',
  warning: "We'll only show this key once.",
  confirmLabel: 'Continue',
};

/** The rendered checkbox, which is the gate a user actually meets. */
function checkbox(container: Element): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="recovery-key-saved"] input[role="checkbox"]',
  );
}

describe('RecoveryKeySaveComponent', () => {
  it('shows the key and holds the way out shut until it is saved', async () => {
    const { container, fixture } = await render(RecoveryKeySaveComponent, {
      inputs,
    });

    expect(container.textContent).toContain(KEY);
    const confirm = screen.getByRole('button', { name: 'Continue' });
    expect(confirm).toBeDisabled();

    checkbox(container)?.click();
    fixture.detectChanges();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('emits once the user says the key is saved', async () => {
    const confirmed = vi.fn();
    const { container, fixture } = await render(RecoveryKeySaveComponent, {
      inputs,
      on: { confirmed },
    });

    checkbox(container)?.click();
    fixture.detectChanges();
    screen.getByRole('button', { name: 'Continue' }).click();

    expect(confirmed).toHaveBeenCalledOnce();
  });

  it('re-shuts the gate when a DIFFERENT key is shown', async () => {
    // A surface can present a second key without being destroyed in between — a reset
    // whose returnTo points at the page it is already on navigates nowhere. Carrying the
    // previous tick over would hand someone a shown-once key with the gate already open.
    const { container, fixture } = await render(RecoveryKeySaveComponent, {
      inputs,
    });

    checkbox(container)?.click();
    fixture.detectChanges();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    fixture.componentRef.setInput('recoveryKey', 'EsTdifferentkey');
    fixture.detectChanges();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('names the checkbox with the words that are on screen', async () => {
    // An aria-label here would win over the visible text and leave a speech-input user
    // unable to activate the control by saying what they can see (WCAG 2.5.3).
    const { container } = await render(RecoveryKeySaveComponent, { inputs });

    expect(container.textContent).toContain(
      "I've saved my recovery key somewhere safe",
    );
    expect(
      screen.getByRole('checkbox', {
        name: /I've saved my recovery key somewhere safe/,
      }),
    ).toBeTruthy();
  });
});
