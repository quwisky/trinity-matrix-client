import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ExternalBrowserService } from '@trinity/platform-native';
import { fireEvent, render, screen } from '@trinity/testing';
import { ReauthBrowserStepComponent } from './reauth-browser-step.component';

async function setup(pending = false, variant?: 'danger' | 'primary') {
  const done = vi.fn();
  const back = vi.fn();
  const rendered = await render(ReauthBrowserStepComponent, {
    inputs: {
      testIdPrefix: 'add-email',
      url: 'https://example.org/fallback?session=s',
      pending,
      body: 'Confirm this in your browser.',
      pendingMessage: 'Not received yet.',
      doneLabel: 'I’ve confirmed',
      ...(variant ? { variant } : {}),
    },
    on: { done, back },
    providers: [
      MockProvider(ExternalBrowserService, { open: vi.fn(() => of(true)) }),
    ],
  });
  return { ...rendered, done, back };
}

describe('ReauthBrowserStepComponent', () => {
  it.each([
    [undefined, 'primary'],
    ['danger', 'danger'],
  ] as const)('renders Done with variant %s as %s', async (given, shown) => {
    await setup(false, given);

    expect(
      screen
        .getByTestId('add-email-browser-confirm')
        .getAttribute('data-trn-variant'),
    ).toBe(shown);
  });

  it('enables Done only after the page was opened', async () => {
    const test = await setup();
    const confirm = screen.getByTestId(
      'add-email-browser-confirm',
    ) as HTMLButtonElement;

    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('add-email-open-page'));
    await test.fixture.whenStable();
    expect(TestBed.inject(ExternalBrowserService).open).toHaveBeenCalledWith(
      'https://example.org/fallback?session=s',
    );
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(test.done).toHaveBeenCalled();
  });

  it('says the server has not seen the confirmation and keeps Done enabled when pending', async () => {
    await setup(true);

    expect(
      screen.getByTestId('add-email-browser-pending').textContent,
    ).toContain('Not received yet.');
    expect(
      (screen.getByTestId('add-email-browser-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('emits back', async () => {
    const test = await setup();

    fireEvent.click(screen.getByTestId('add-email-back'));

    expect(test.back).toHaveBeenCalled();
  });
});
