import { TrnDialogRef } from '@trinity/components/overlay';
import {
  AppLockService,
  type UnlockOutcome,
} from '@trinity/data-access/app-lock';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { AppLockPinDialogComponent } from './app-lock-pin-dialog.component';

// The fixture PIN. Failure messages never print a PIN: presence checks use `.toBe(false)`.
const PIN = '482913';

/** One macrotask for the zoneless renderer, in real or fake time. */
async function tick(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((resolve) => setTimeout(resolve));
}

async function click(element: Element): Promise<void> {
  fireEvent.click(element);
  await tick();
}

/** Types `value` into a field as one input event. */
async function type(element: Element, value: string): Promise<void> {
  fireEvent.input(element, { target: { value } });
  await tick();
}

async function setup(
  mode: 'set' | 'verify',
  methodName: string | null,
  options: { verify?: UnlockOutcome; appName?: string } = {},
) {
  const close = vi.fn();
  const verifyPinForChange = vi.fn(() =>
    of<UnlockOutcome>(options.verify ?? { kind: 'unlocked' }),
  );
  const view = await render(AppLockPinDialogComponent, {
    inputs: { mode, methodName },
    providers: [
      { provide: TrnDialogRef, useValue: { close, closed: of(undefined) } },
      MockProvider(AppLockService, {
        appName: options.appName ?? 'Trinity',
        verifyPinForChange,
      }),
    ],
  });
  return { close, verifyPinForChange, view };
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe('AppLockPinDialogComponent', () => {
  it('reveals each PIN from a toggle inside its own field', async () => {
    const { view } = await setup('set', null);
    const [pinToggle] = screen.getAllByRole('button', {
      name: 'Show PIN',
    });

    expect(field('New PIN').parentElement?.localName).toBe(
      'trn-password-input',
    );
    expect(field('New PIN').type).toBe('password');
    expect(field('Confirm PIN').type).toBe('password');

    fireEvent.click(pinToggle);
    view.fixture.detectChanges();

    expect(field('New PIN').type).toBe('text');
    expect(field('Confirm PIN').type).toBe('password');
  });

  describe('set', () => {
    it('sets a PIN typed twice and warns that a forgotten one means erasing', async () => {
      const { close } = await setup('set', 'Face ID or your device passcode');
      expect(
        screen.getByText(
          /If you can’t use Face ID or your device passcode and you forget this PIN, the only way back into Trinity is to erase all data on this device\./,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(/That signs out every account\./).textContent,
      ).toContain('recovery key or another signed-in device');
      await type(field('New PIN'), PIN);
      await type(field('Confirm PIN'), PIN);
      await click(screen.getByRole('button', { name: 'Set PIN' }));
      expect(close).toHaveBeenCalledWith({ kind: 'pin', pin: PIN });
    });

    it('clears both fields once the PIN leaves the dialog', async () => {
      await setup('set', null);
      await type(field('New PIN'), PIN);
      await type(field('Confirm PIN'), PIN);
      await click(screen.getByRole('button', { name: 'Set PIN' }));
      expect(field('New PIN').value).toBe('');
      expect(field('Confirm PIN').value).toBe('');
    });

    it('names the running app in the warning and title', async () => {
      await setup('set', null, { appName: 'Trinity Next' });
      expect(
        screen.getByText(
          /If you forget this PIN, the only way back into Trinity Next is to erase all data/,
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole('heading', { name: 'Set a Trinity Next PIN' }),
      ).toBeTruthy();
    });

    it('refuses PINs that differ or are not 4 to 16 digits, and announces why', async () => {
      const { close } = await setup('set', null);
      await type(field('New PIN'), '123');
      await type(field('Confirm PIN'), '124');
      await click(screen.getByRole('button', { name: 'Set PIN' }));
      expect(close).not.toHaveBeenCalled();
      const digits = screen.getByText('Enter 4 to 16 digits.');
      const mismatch = screen.getByText('The PINs don’t match.');
      expect(digits.getAttribute('role')).toBe('alert');
      expect(mismatch.getAttribute('role')).toBe('alert');
      expect(field('New PIN')).toHaveAccessibleDescription(
        'Enter 4 to 16 digits.',
      );
      expect(field('Confirm PIN')).toHaveAccessibleDescription(
        'The PINs don’t match.',
      );
      expect(field('New PIN').getAttribute('aria-invalid')).toBe('true');
    });

    it('refuses letters', async () => {
      const { close } = await setup('set', null);
      await type(field('New PIN'), '12ab');
      await type(field('Confirm PIN'), '12ab');
      await click(screen.getByRole('button', { name: 'Set PIN' }));
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByText('Enter 4 to 16 digits.')).toBeTruthy();
    });

    it('accepts 4 digits and suggests 6 or more', async () => {
      const { close } = await setup('set', null);
      expect(field('New PIN')).toHaveAccessibleDescription(
        '4 to 16 digits. Use 6 or more if you can.',
      );
      await type(field('New PIN'), '4829');
      await type(field('Confirm PIN'), '4829');
      await click(screen.getByRole('button', { name: 'Set PIN' }));
      expect(close).toHaveBeenCalledWith({ kind: 'pin', pin: '4829' });
    });

    it('asks for a numeric PIN the browser never saves or shows', async () => {
      await setup('set', null);
      for (const input of [field('New PIN'), field('Confirm PIN')]) {
        expect(input.type).toBe('password');
        expect(input.getAttribute('inputmode')).toBe('numeric');
        expect(input.getAttribute('autocomplete')).toBe('off');
        expect(input.getAttribute('maxlength')).toBe('16');
      }
      await type(field('New PIN'), PIN);
      expect(document.body.textContent?.includes(PIN)).toBe(false);
    });

    it('starts in the PIN field', async () => {
      await setup('set', null);
      expect(field('New PIN').hasAttribute('data-autofocus')).toBe(true);
    });

    it('cancels without a PIN, from its one Cancel button', async () => {
      const { close } = await setup('set', null);
      // The footer cancels; no second control (an X) carries the same name.
      expect(
        screen.getAllByRole('button', { name: /^(Cancel|Close)$/ }),
      ).toHaveLength(1);
      await type(field('New PIN'), PIN);
      await click(screen.getByRole('button', { name: 'Cancel' }));
      expect(close).toHaveBeenCalledWith();
    });
  });

  describe('verify', () => {
    it('confirms the current PIN for a change', async () => {
      const { close, verifyPinForChange } = await setup('verify', 'Face ID');
      expect(
        screen.getByRole('heading', { name: 'Enter your Trinity PIN' }),
      ).toBeTruthy();
      expect(screen.queryByLabelText('Confirm PIN')).toBeNull();
      await type(field('Trinity PIN'), PIN);
      await click(screen.getByRole('button', { name: 'Confirm' }));
      expect(verifyPinForChange).toHaveBeenCalledWith(PIN);
      expect(close).toHaveBeenCalledWith({ kind: 'verified' });
      expect(field('Trinity PIN').value).toBe('');
    });

    it('says a wrong PIN, clears the field and puts focus back in it', async () => {
      const { close } = await setup('verify', null, {
        verify: { kind: 'failed', until: null },
      });
      await type(field('Trinity PIN'), '000000');
      await click(screen.getByRole('button', { name: 'Confirm' }));
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        'That PIN isn’t right. Try again.',
      );
      expect(field('Trinity PIN').value).toBe('');
      expect(document.activeElement).toBe(field('Trinity PIN'));
    });

    it('counts a wait down and refuses to submit until it ends', async () => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const until = Date.now() + 30_000;
      const { verifyPinForChange } = await setup('verify', null, {
        verify: { kind: 'delayed', until },
      });
      await type(field('Trinity PIN'), '000000');
      await click(screen.getByRole('button', { name: 'Confirm' }));
      const shown = () =>
        screen.getByTestId('app-lock-pin-message').textContent?.trim();
      expect(shown()).toBe('Too many wrong PINs. Try again in 30 seconds.');
      // Announced once, not every second.
      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        'Too many wrong PINs. Try again in 30 seconds.',
      );
      const confirm = screen.getByRole('button', { name: 'Confirm' });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);

      await vi.advanceTimersByTimeAsync(11_500);
      await tick();
      expect(shown()).toBe('Too many wrong PINs. Try again in 19 seconds.');
      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        'Too many wrong PINs. Try again in 30 seconds.',
      );
      await type(field('Trinity PIN'), '111111');
      fireEvent.submit(field('Trinity PIN').form as HTMLFormElement);
      await tick();
      expect(verifyPinForChange).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(20_000);
      await tick();
      expect(shown()).toBe('Too many wrong PINs. Try again.');
      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        'You can try again now.',
      );
      expect((confirm as HTMLButtonElement).disabled).toBe(false);
    });

    it('never shows a negative wait for a deadline already passed', async () => {
      await setup('verify', null, {
        verify: { kind: 'delayed', until: Date.now() - 5_000 },
      });
      await type(field('Trinity PIN'), '000000');
      await click(screen.getByRole('button', { name: 'Confirm' }));
      expect(
        screen.getByTestId('app-lock-pin-message').textContent?.trim(),
      ).toBe('Too many wrong PINs. Try again.');
      expect(
        (screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    it('says how long to wait after too many wrong PINs', async () => {
      const until = Date.now() + 60_000;
      await setup('verify', null, { verify: { kind: 'delayed', until } });
      await type(field('Trinity PIN'), '000000');
      await click(screen.getByRole('button', { name: 'Confirm' }));
      expect(screen.getByRole('alert').textContent).toContain(
        'Try again in 1 minute',
      );
    });

    it('says when a wrong PIN starts a wait', async () => {
      const until = Date.now() + 30_000;
      await setup('verify', null, { verify: { kind: 'failed', until } });
      await type(field('Trinity PIN'), '000000');
      await click(screen.getByRole('button', { name: 'Confirm' }));
      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        'That PIN isn’t right. Try again in 30 seconds.',
      );
    });

    it('says when the PIN cannot be read, naming the running app', async () => {
      const { close } = await setup('verify', null, {
        verify: { kind: 'unavailable' },
        appName: 'Trinity Next',
      });
      await type(field('Trinity Next PIN'), PIN);
      await click(screen.getByRole('button', { name: 'Confirm' }));
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        'Trinity Next can’t read your PIN right now. Try again.',
      );
    });

    it('closes without a result when the app locked meanwhile', async () => {
      const { close } = await setup('verify', null, {
        verify: { kind: 'cancelled' },
      });
      await type(field('Trinity PIN'), PIN);
      await click(screen.getByRole('button', { name: 'Confirm' }));
      expect(close).toHaveBeenCalledWith();
    });

    it('asks for the PIN when the field is empty', async () => {
      const { verifyPinForChange } = await setup('verify', null);
      await click(screen.getByRole('button', { name: 'Confirm' }));
      expect(verifyPinForChange).not.toHaveBeenCalled();
      expect(screen.getByText('Enter your Trinity PIN.')).toBeTruthy();
    });
  });
});
