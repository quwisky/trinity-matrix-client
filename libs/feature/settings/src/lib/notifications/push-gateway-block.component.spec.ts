import { signal, type WritableSignal } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import { DEFAULT_PUSH_GATEWAY_URL } from '@trinity/util/push-client';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  PushGatewayService,
  PushService,
  type PushRegistrationState,
} from '@trinity/data-access/notifications';
import { PushGatewayBlockComponent } from './push-gateway-block.component';

interface Stub {
  supported: boolean;
  override: { gatewayUrl: string } | null;
  fallback: { gatewayUrl: string } | null;
  registration: PushRegistrationState;
  confirm: boolean;
  clearFails: boolean;
  unregisterFails: boolean;
}

const NOTIFY = 'https://push.example.org/_matrix/push/v1/notify';

let saveSpy: Mock;
let clearSpy: Mock;
let registerSpy: Mock;
let unregisterSpy: Mock;
let retrySpy: Mock;
let dialogResult: WritableSignal<boolean>;

function providers(overrides: Partial<Stub> = {}) {
  const stub: Stub = {
    supported: true,
    override: null,
    fallback: null,
    registration: { status: 'idle' },
    confirm: true,
    clearFails: false,
    unregisterFails: false,
    ...overrides,
  };
  saveSpy = vi.fn(async () => undefined);
  clearSpy = vi.fn(async () => {
    if (stub.clearFails) throw new Error('storage details');
  });
  registerSpy = vi.fn(() => of(undefined));
  unregisterSpy = vi.fn(() => {
    if (stub.unregisterFails) {
      return throwError(() => new Error('cleanup details'));
    }
    return of(undefined);
  });
  retrySpy = vi.fn(() => of(undefined));
  dialogResult = signal(stub.confirm);

  return [
    MockProvider(PushGatewayService, {
      supported: signal(stub.supported).asReadonly(),
      override: signal(stub.override).asReadonly(),
      effective: signal(stub.override ?? stub.fallback).asReadonly(),
      save: saveSpy,
      clear: clearSpy,
    }),
    MockProvider(PushService, {
      registration: signal(stub.registration).asReadonly(),
      register: registerSpy,
      unregister: unregisterSpy,
      retryRegistration: retrySpy,
    }),
    MockProvider(TrnDialogService, {
      openAndWait$: vi.fn(() =>
        of(dialogResult()),
      ) as TrnDialogService['openAndWait$'],
    }),
  ];
}

describe('PushGatewayBlockComponent', () => {
  it('shows the unsupported note and no inputs off mobile', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({ supported: false }),
    });

    expect(
      container.querySelector('[data-testid=push-gateway-unsupported]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid=push-gateway-url]'),
    ).toBeNull();
  });

  it('renders the URL field on mobile', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers(),
    });

    expect(
      container.querySelector('[data-testid=push-gateway-url]'),
    ).not.toBeNull();
  });

  it('shows the placeholder default and asks for a deployed gateway', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({
        fallback: { gatewayUrl: DEFAULT_PUSH_GATEWAY_URL },
      }),
    });
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid=push-gateway-url]',
      )?.value,
    ).toBe(DEFAULT_PUSH_GATEWAY_URL);
    expect(
      container.querySelector('[data-testid=push-gateway-placeholder]')
        ?.textContent,
    ).toContain('Enter your deployed Trinity');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid=push-gateway-save]',
      )?.disabled,
    ).toBe(true);
  });

  it('seeds the fields from a stored override', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({
        override: { gatewayUrl: NOTIFY },
      }),
    });

    const url = container.querySelector<HTMLInputElement>(
      '[data-testid=push-gateway-url]',
    );
    expect(url?.value).toBe(NOTIFY);
    expect(
      container.querySelector('[data-testid=push-gateway-appid]'),
    ).toBeNull();
  });

  it('clears the drafts after a clear', async () => {
    const { fixture } = await render(PushGatewayBlockComponent, {
      providers: providers({
        override: { gatewayUrl: NOTIFY },
      }),
    });
    const cmp = fixture.componentInstance;
    expect(cmp.urlDraft()).toBe(NOTIFY);

    cmp.clear();

    await vi.waitFor(() => expect(cmp.urlDraft()).toBe(''));
  });

  it('disables Save until a valid, changed URL is entered', async () => {
    const { fixture, container } = await render(PushGatewayBlockComponent, {
      providers: providers(),
    });
    const cmp = fixture.componentInstance;
    const save = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid=push-gateway-save]',
      );

    expect(save()?.disabled).toBe(true); // empty

    cmp.urlDraft.set('not a url');
    fixture.detectChanges();
    expect(save()?.disabled).toBe(true); // invalid

    cmp.urlDraft.set(NOTIFY);
    fixture.detectChanges();
    expect(save()?.disabled).toBe(false); // valid + differs from stored (null)
  });

  it('surfaces a validation message for a wrong path', async () => {
    const { fixture, container } = await render(PushGatewayBlockComponent, {
      providers: providers(),
    });
    fixture.componentInstance.urlDraft.set('https://push.example.org/wrong');
    fixture.detectChanges();

    const error = container.querySelector('[data-testid=push-gateway-error]');
    expect(error?.textContent).toContain('/_matrix/push/v1/notify');
  });

  it('previews the normalised URL for a bare origin', async () => {
    const { fixture, container } = await render(PushGatewayBlockComponent, {
      providers: providers(),
    });
    fixture.componentInstance.urlDraft.set('https://push.example.org');
    fixture.detectChanges();

    const hint = container.querySelector(
      '[data-testid=push-gateway-normalized]',
    );
    expect(hint?.textContent).toContain(NOTIFY);
  });

  it('warns about an http gateway but still allows saving it', async () => {
    const { fixture, container } = await render(PushGatewayBlockComponent, {
      providers: providers(),
    });
    fixture.componentInstance.urlDraft.set('http://192.168.1.10:5000');
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid=push-gateway-insecure]'),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid=push-gateway-save]',
      )?.disabled,
    ).toBe(false);
  });

  it('confirms trust, persists the normalised URL, then registers', async () => {
    const { fixture } = await render(PushGatewayBlockComponent, {
      providers: providers({ confirm: true }),
    });
    fixture.componentInstance.urlDraft.set('https://push.example.org');

    await fixture.componentInstance.save();

    await vi.waitFor(() => expect(saveSpy).toHaveBeenCalledWith(NOTIFY));
    expect(registerSpy).toHaveBeenCalled();
  });

  it('does nothing when trust is declined', async () => {
    const { fixture } = await render(PushGatewayBlockComponent, {
      providers: providers({ confirm: false }),
    });
    fixture.componentInstance.urlDraft.set(NOTIFY);

    await fixture.componentInstance.save();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('persists disabled before tearing pushers down', async () => {
    const { fixture } = await render(PushGatewayBlockComponent, {
      providers: providers({ override: { gatewayUrl: NOTIFY } }),
    });

    fixture.componentInstance.clear();

    // The disabled choice must be durable before cleanup starts, so a failed cleanup
    // cannot leave push enabled while the UI reports an incomplete operation.
    await vi.waitFor(() => expect(unregisterSpy).toHaveBeenCalled());
    await vi.waitFor(() => expect(clearSpy).toHaveBeenCalled());
    expect(clearSpy.mock.invocationCallOrder[0]).toBeLessThan(
      unregisterSpy.mock.invocationCallOrder[0],
    );
  });

  it('hides Clear when no gateway is configured', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({ override: null }),
    });
    expect(
      container.querySelector('[data-testid=push-gateway-clear]'),
    ).toBeNull();
  });

  it('offers Clear for a build default', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({
        fallback: { gatewayUrl: DEFAULT_PUSH_GATEWAY_URL },
      }),
    });
    expect(
      container.querySelector('[data-testid=push-gateway-clear]'),
    ).not.toBeNull();
  });

  it('offers Clear when an override is stored', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({ override: { gatewayUrl: NOTIFY } }),
    });
    expect(
      container.querySelector('[data-testid=push-gateway-clear]'),
    ).not.toBeNull();
  });

  it('shows a registered status without claiming delivery', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({
        registration: { status: 'applied', accounts: 2, at: 1 },
      }),
    });

    const status = container.querySelector('[data-testid=push-gateway-status]');
    expect(status?.textContent).toContain('2 accounts');
    // The honesty line: registered, not "working".
    expect(status?.textContent).not.toContain('working');
    expect(status?.textContent).toContain(
      'not that a notification has arrived',
    );
  });

  it('shows the homeserver error when registration failed', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({
        registration: { status: 'error', message: 'Config Error: bad path' },
      }),
    });

    const status = container.querySelector('[data-testid=push-gateway-status]');
    expect(status?.textContent).toContain('Config Error: bad path');
    expect(
      container.querySelector('[data-testid=push-gateway-retry]'),
    ).not.toBeNull();
  });

  it('retries a failed registration from the visible control', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({
        registration: { status: 'error', message: 'Try again' },
      }),
    });

    container
      .querySelector<HTMLButtonElement>('[data-testid=push-gateway-retry]')
      ?.click();

    expect(retrySpy).toHaveBeenCalledOnce();
  });

  it('does not unregister when persisting Clear fails', async () => {
    const { fixture } = await render(PushGatewayBlockComponent, {
      providers: providers({
        override: { gatewayUrl: NOTIFY },
        clearFails: true,
      }),
    });
    fixture.componentInstance.clear();

    await vi.waitFor(() =>
      expect(fixture.componentInstance.recoveryError()).toContain(
        'could not be completed',
      ),
    );
    expect(unregisterSpy).not.toHaveBeenCalled();
  });

  it('shows recovery when cleanup fails after disabling the gateway', async () => {
    const { fixture, container } = await render(PushGatewayBlockComponent, {
      providers: providers({
        override: { gatewayUrl: NOTIFY },
        unregisterFails: true,
      }),
    });
    fixture.componentInstance.clear();

    await vi.waitFor(() =>
      expect(fixture.componentInstance.recoveryError()).toContain(
        'could not be completed',
      ),
    );
    expect(
      container.querySelector('[data-testid=push-gateway-retry]'),
    ).not.toBeNull();
  });

  it('describes the URL field with its help text, for a screen reader', async () => {
    // Two of the three places in the app that describe a helm control. The hint was in the
    // markup all along but never reached the accessibility tree: trnInput composes
    // BrnFieldControlDescribedBy, which owns [attr.aria-describedby], and the hostDirectives
    // entry did not publish that input — so the attribute was computed as null and removed.
    // Asserted here as well as in the kit's own contract test, because this is the screen a
    // person actually uses.
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers(),
    });

    expect(
      container
        .querySelector('[data-testid=push-gateway-url]')
        ?.getAttribute('aria-describedby'),
    ).toBe('push-gateway-help');
    expect(container.querySelector('#push-gateway-help')).not.toBeNull();
  });
});
