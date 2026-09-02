import { signal, type WritableSignal } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  PushGatewayService,
  PushService,
  type PushRegistrationState,
} from '@trinity/data-access/notifications';
import { PushGatewayBlockComponent } from './push-gateway-block.component';

interface Stub {
  supported: boolean;
  override: { gatewayUrl: string; appId?: string } | null;
  registration: PushRegistrationState;
  confirm: boolean;
}

const NOTIFY = 'https://push.example.org/_matrix/push/v1/notify';

let saveSpy: Mock;
let clearSpy: Mock;
let registerSpy: Mock;
let unregisterSpy: Mock;
let dialogResult: WritableSignal<boolean>;

function providers(overrides: Partial<Stub> = {}) {
  const stub: Stub = {
    supported: true,
    override: null,
    registration: { status: 'idle' },
    confirm: true,
    ...overrides,
  };
  saveSpy = vi.fn(async () => undefined);
  clearSpy = vi.fn(async () => undefined);
  registerSpy = vi.fn(() => of(undefined));
  unregisterSpy = vi.fn(() => of(undefined));
  dialogResult = signal(stub.confirm);

  return [
    MockProvider(PushGatewayService, {
      supported: signal(stub.supported).asReadonly(),
      override: signal(stub.override).asReadonly(),
      save: saveSpy,
      clear: clearSpy,
    }),
    MockProvider(PushService, {
      registration: signal(stub.registration).asReadonly(),
      register: registerSpy,
      unregister: unregisterSpy,
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

  it('seeds the fields from a stored override', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({
        override: { gatewayUrl: NOTIFY, appId: 'org.example.gw' },
      }),
    });

    const url = container.querySelector<HTMLInputElement>(
      '[data-testid=push-gateway-url]',
    );
    expect(url?.value).toBe(NOTIFY);
    // A stored app id opens the advanced section and prefills it.
    const appId = container.querySelector<HTMLInputElement>(
      '[data-testid=push-gateway-appid]',
    );
    expect(appId?.value).toBe('org.example.gw');
  });

  it('hides the app id behind the advanced toggle until revealed', async () => {
    const { fixture, container } = await render(PushGatewayBlockComponent, {
      providers: providers(),
    });
    expect(
      container.querySelector('[data-testid=push-gateway-appid]'),
    ).toBeNull();

    fixture.componentInstance.toggleAdvanced();
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid=push-gateway-appid]'),
    ).not.toBeNull();
  });

  it('clears the drafts after a clear', async () => {
    const { fixture } = await render(PushGatewayBlockComponent, {
      providers: providers({
        override: { gatewayUrl: NOTIFY, appId: 'org.example.gw' },
      }),
    });
    const cmp = fixture.componentInstance;
    expect(cmp.urlDraft()).toBe(NOTIFY);

    cmp.clear();

    await vi.waitFor(() => expect(cmp.urlDraft()).toBe(''));
    expect(cmp.appIdDraft()).toBe('');
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

    await vi.waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith(NOTIFY, undefined),
    );
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

  it('passes the advanced app id through when set', async () => {
    const { fixture } = await render(PushGatewayBlockComponent, {
      providers: providers({ confirm: true }),
    });
    fixture.componentInstance.urlDraft.set(NOTIFY);
    fixture.componentInstance.appIdDraft.set('org.example.gw');

    await fixture.componentInstance.save();

    await vi.waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith(NOTIFY, 'org.example.gw'),
    );
  });

  it('tears pushers down before clearing the stored gateway', async () => {
    const { fixture } = await render(PushGatewayBlockComponent, {
      providers: providers({ override: { gatewayUrl: NOTIFY } }),
    });

    fixture.componentInstance.clear();

    // unregister() must run before gateway.clear() — clearing drops the ledger the
    // teardown reads to know which pushers to remove.
    expect(unregisterSpy).toHaveBeenCalled();
    await vi.waitFor(() => expect(clearSpy).toHaveBeenCalled());
    expect(unregisterSpy.mock.invocationCallOrder[0]).toBeLessThan(
      clearSpy.mock.invocationCallOrder[0],
    );
  });

  it('hides Clear when no override is stored', async () => {
    const { container } = await render(PushGatewayBlockComponent, {
      providers: providers({ override: null }),
    });
    expect(
      container.querySelector('[data-testid=push-gateway-clear]'),
    ).toBeNull();
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
