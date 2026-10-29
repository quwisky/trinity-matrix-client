import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { IdentityPresenceService } from '@trinity/data-access/identity';
import { type PresenceState } from '@trinity/util/matrix';
import { PresenceSectionComponent } from './presence-section.component';

function providers(
  over: {
    presence?: PresenceState;
    status?: string;
    setOwnPresence?: Mock;
  } = {},
) {
  const setOwnPresence = over.setOwnPresence ?? vi.fn(() => of(undefined));
  return {
    list: [
      MockProvider(IdentityPresenceService, {
        myPresence: signal<PresenceState>(
          over.presence ?? 'online',
        ).asReadonly(),
        myStatusMessage: signal(over.status ?? '').asReadonly(),
        loadOwnPresence: vi.fn(() => of(undefined)),
        setOwnPresence,
      }),
    ],
    setOwnPresence,
  };
}

describe('PresenceSectionComponent', () => {
  it('renders a radio option for each presence state', async () => {
    const { container } = await render(PresenceSectionComponent, {
      providers: providers().list,
    });
    for (const state of ['online', 'unavailable', 'offline']) {
      expect(
        container.querySelector(`[data-testid=presence-${state}]`),
      ).not.toBeNull();
    }
  });

  it('disables Save until the form differs from the published state', async () => {
    const { fixture, container } = await render(PresenceSectionComponent, {
      providers: providers({ presence: 'online', status: '' }).list,
    });
    const save = container.querySelector<HTMLButtonElement>(
      '[data-testid=presence-save]',
    )!;
    expect(save.disabled).toBe(true);

    fixture.componentInstance.onStateChange('offline');
    fixture.detectChanges();
    expect(save.disabled).toBe(false);
  });

  it('publishes the chosen state and status, then confirms', async () => {
    const { list, setOwnPresence } = providers();
    const { fixture, container } = await render(PresenceSectionComponent, {
      providers: list,
    });
    const cmp = fixture.componentInstance;

    cmp.onStateChange('unavailable');
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid=presence-status]',
    )!;
    input.value = 'in a meeting';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    container
      .querySelector<HTMLButtonElement>('[data-testid=presence-save]')!
      .click();
    fixture.detectChanges();

    expect(setOwnPresence).toHaveBeenCalledWith('unavailable', 'in a meeting');
    expect(
      container.querySelector('[data-testid=presence-saved]'),
    ).not.toBeNull();
  });

  it('seeds the form from the currently published presence', async () => {
    const { fixture } = await render(PresenceSectionComponent, {
      providers: providers({ presence: 'unavailable', status: 'brb' }).list,
    });
    expect(fixture.componentInstance.stateDraft()).toBe('unavailable');
    expect(fixture.componentInstance.statusDraft()).toBe('brb');
  });

  it('takes its values when the own presence arrives late, keeping Save off until then', async () => {
    const myPresence = signal<PresenceState>('online');
    const myStatusMessage = signal('');
    const answer = new Subject<void>();
    const { fixture, container } = await render(PresenceSectionComponent, {
      providers: [
        MockProvider(IdentityPresenceService, {
          myPresence: myPresence.asReadonly(),
          myStatusMessage: myStatusMessage.asReadonly(),
          loadOwnPresence: () => answer,
          setOwnPresence: vi.fn(() => of(undefined)),
        }),
      ],
    });
    const cmp = fixture.componentInstance;
    const save = container.querySelector<HTMLButtonElement>(
      '[data-testid=presence-save]',
    )!;

    cmp.onStateChange('offline');
    fixture.detectChanges();
    expect(save.disabled).toBe(true);

    // The service holds the server's answer before its load completes.
    myPresence.set('unavailable');
    myStatusMessage.set('brb');
    answer.complete();
    fixture.detectChanges();

    expect(cmp.stateDraft()).toBe('unavailable');
    expect(cmp.statusDraft()).toBe('brb');
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid=presence-status]',
      )!.value,
    ).toBe('brb');
    expect(save.disabled).toBe(true);
  });
});
