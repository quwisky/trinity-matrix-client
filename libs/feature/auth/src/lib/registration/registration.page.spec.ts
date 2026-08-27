import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import {
  AuthService,
  RegistrationService,
  type RegistrationStage,
} from '@trinity/data-access/auth';
import { ExternalBrowserService } from '@trinity/platform-native';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegistrationPage } from './registration.page';

describe('RegistrationPage', () => {
  let stage: WritableSignal<RegistrationStage>;
  let busy: WritableSignal<boolean>;
  let error: WritableSignal<string | null>;

  beforeEach(() => {
    stage = signal<RegistrationStage>({ kind: 'idle' });
    busy = signal(false);
    error = signal<string | null>(null);
  });

  async function renderPage(options: { add?: boolean } = {}) {
    const queryParamMap = {
      get: (key: string) => (key === 'homeserver' ? 'example.org' : null),
      has: (key: string) => key === 'add' && !!options.add,
    };
    const registration = {
      stage: stage.asReadonly(),
      busy: busy.asReadonly(),
      error: error.asReadonly(),
      getAvailability: vi.fn(() => of('open' as const)),
      begin: vi.fn(() => of(undefined)),
      provideEmail: vi.fn(),
      acceptTerms: vi.fn(() => of(undefined)),
      submitRegistrationToken: vi.fn(() => of(undefined)),
      resendEmail: vi.fn(() => of(undefined)),
      poll: vi.fn(() => of(undefined)),
      retryEstablishment: vi.fn(() => of(undefined)),
      cancel: vi.fn(),
    };
    const { fixture } = await render(RegistrationPage, {
      providers: [
        MockProvider(AuthService, {
          discoverHomeserver: vi.fn(() => of('https://hs.example')),
          getSupportedFlows: vi.fn(() => of(['m.login.password'])),
          getDelegatedAuthConfig: vi.fn(() => of(null)),
        }),
        { provide: RegistrationService, useValue: registration },
        MockProvider(ExternalBrowserService, {
          open: vi.fn(() => of(true)),
        }),
        MockProvider(Router),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap } } },
      ],
    });
    return {
      fixture,
      cmp: fixture.componentInstance,
      registration,
      router: TestBed.inject(Router),
      browser: TestBed.inject(ExternalBrowserService),
    };
  }

  it('rediscovers the selected homeserver and renders account credentials', async () => {
    const { fixture, cmp, registration } = await renderPage();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(cmp.baseUrl()).toBe('https://hs.example');
    expect(registration.getAvailability).toHaveBeenCalledWith(
      'https://hs.example',
    );
    expect(root.querySelector('h1')?.textContent).toContain(
      'Create a Trinity account',
    );
    expect(root.querySelector('#registration-username')).not.toBeNull();
    expect(root.querySelector('#registration-password')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  it('does not start registration when password confirmation differs', async () => {
    const { fixture, cmp, registration } = await renderPage();
    cmp.credentialsForm.username().value.set('alice');
    cmp.credentialsForm.password().value.set('first');
    cmp.credentialsForm.confirmPassword().value.set('second');

    cmp.createAccount();
    await fixture.whenStable();

    expect(registration.begin).not.toHaveBeenCalled();
    expect(cmp.credentialsForm.confirmPassword().errors()[0]?.message).toBe(
      'Passwords do not match.',
    );
  });

  it('preserves add-account mode and enters encryption setup after success', async () => {
    const { fixture, cmp, registration, router } = await renderPage({
      add: true,
    });
    cmp.credentialsForm.username().value.set('alice');
    cmp.credentialsForm.password().value.set('secret');
    cmp.credentialsForm.confirmPassword().value.set('secret');

    cmp.createAccount();
    await fixture.whenStable();

    expect(registration.begin).toHaveBeenCalledWith(
      'https://hs.example',
      'alice',
      'secret',
      'add',
    );
    expect(router.navigateByUrl).toHaveBeenCalledWith('/encryption/setup', {
      replaceUrl: true,
    });
  });

  it('requires explicit terms consent before submitting the stage', async () => {
    const { fixture, cmp, registration } = await renderPage();
    cmp.started.set(true);
    stage.set({
      kind: 'terms',
      policies: [
        {
          id: 'privacy',
          name: 'Privacy policy',
          url: 'https://hs/privacy',
          version: '1',
        },
      ],
    });
    await fixture.whenStable();

    cmp.acceptTerms();
    expect(registration.acceptTerms).not.toHaveBeenCalled();

    cmp.termsAccepted.set(true);
    cmp.acceptTerms();
    expect(registration.acceptTerms).toHaveBeenCalledOnce();
  });

  it('opens hosted fallback externally before enabling its completion poll', async () => {
    const { fixture, cmp, registration, browser } = await renderPage();
    cmp.started.set(true);
    stage.set({
      kind: 'fallback',
      authType: 'm.login.recaptcha',
      url: 'https://hs/_matrix/client/v3/auth/m.login.recaptcha/fallback/web',
    });
    await fixture.whenStable();

    const root = fixture.nativeElement as HTMLElement;
    const complete = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('I completed this step'),
    );
    expect(complete?.disabled).toBe(true);

    cmp.openFallback(
      'https://hs/_matrix/client/v3/auth/m.login.recaptcha/fallback/web',
    );
    await fixture.whenStable();

    expect(browser.open).toHaveBeenCalled();
    expect(cmp.fallbackOpened()).toBe(true);
    cmp.poll();
    expect(registration.poll).toHaveBeenCalledOnce();
  });
});
