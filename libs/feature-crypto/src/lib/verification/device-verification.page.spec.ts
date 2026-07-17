import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogRef } from '@angular/cdk/dialog';
import { fireEvent, render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import {
  VerificationService,
  type VerificationView,
} from '@trinity/data-access-crypto';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DeviceVerificationPage } from './device-verification.page';

function view(partial: Partial<VerificationView>): VerificationView {
  return {
    stage: 'requested',
    otherUserId: '@me:hs',
    otherDeviceId: 'OTHER',
    isSelfVerification: true,
    incoming: false,
    emoji: null,
    cancelReason: null,
    ...partial,
  };
}

async function renderPage(
  active: WritableSignal<VerificationView | null>,
  options: { returnTo?: string | null; asModal?: boolean } = {},
) {
  const { returnTo = null, asModal = false } = options;
  const close = vi.fn();
  const result = await render(DeviceVerificationPage, {
    inputs: { asModal },
    providers: [
      MockProvider(VerificationService, { active }),
      MockProvider(Router),
      MockProvider(ActivatedRoute, {
        snapshot: {
          queryParamMap: {
            get: (key: string) => (key === 'returnTo' ? returnTo : null),
          },
        } as never,
      }),
      MockProvider(DialogRef, { close }),
    ],
  });

  // Every action method returns a cold Observable the page feeds to runWithBusy.
  const svc = TestBed.inject(VerificationService);
  vi.mocked(svc.startSelfVerification).mockReturnValue(of(undefined));
  vi.mocked(svc.accept).mockReturnValue(of(undefined));
  vi.mocked(svc.startSas).mockReturnValue(of(undefined));
  vi.mocked(svc.confirmSas).mockReturnValue(of(undefined));
  vi.mocked(svc.mismatchSas).mockReturnValue(of(undefined));
  vi.mocked(svc.cancel).mockReturnValue(of(undefined));
  const router = TestBed.inject(Router);

  return { ...result, svc, router, close };
}

// Every control on the page is now a native `<button hlmBtn>`: the body buttons,
// the routed header's Close (converted to the app-shell <header>), and the SAS
// "They match"/"They don't match"/"Cancel" controls owned by <trn-sas-compare>.
function button(host: HTMLElement, text: string): HTMLElement {
  return [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLElement;
}

describe('DeviceVerificationPage', () => {
  it('offers to start when nothing is in flight', async () => {
    const { svc, container } = await renderPage(signal(null));

    fireEvent.click(button(container, 'Start verification'));

    expect(svc.startSelfVerification).toHaveBeenCalledOnce();
  });

  it('accepts an incoming request', async () => {
    const { svc, container } = await renderPage(
      signal(view({ stage: 'requested', incoming: true })),
    );

    fireEvent.click(button(container, 'Accept'));

    expect(svc.accept).toHaveBeenCalledOnce();
  });

  // A cross-user request comes from ANY user who can DM you — not from your own
  // session. Labelling it as self-verification would invite the user to click through a
  // stranger's request, cross-signing that stranger's identity for good.
  it('names the other user on an incoming cross-user request', async () => {
    const { container } = await renderPage(
      signal(
        view({
          stage: 'requested',
          incoming: true,
          isSelfVerification: false,
          otherUserId: '@mallory:evil.example',
        }),
      ),
    );

    expect(container.textContent).toContain('@mallory:evil.example');
    expect(container.textContent).not.toContain('Another of your sessions');
  });

  it('names the other user when comparing emoji cross-user', async () => {
    const { container } = await renderPage(
      signal(
        view({
          stage: 'sas-shown',
          isSelfVerification: false,
          otherUserId: '@mallory:evil.example',
          emoji: [{ emoji: '🐶', name: 'Dog' }],
        }),
      ),
    );

    // The trust decision happens here, so this is where the identity must appear.
    expect(container.textContent).toContain('@mallory:evil.example');
  });

  it('still labels a self-verification as your own session', async () => {
    const { container } = await renderPage(
      signal(view({ stage: 'requested', incoming: true })),
    );

    expect(container.textContent).toContain('Another of your sessions');
  });

  it('shows the emoji and confirms on match', async () => {
    const { svc, container } = await renderPage(
      signal(
        view({ stage: 'sas-shown', emoji: [{ glyph: '🐶', name: 'Dog' }] }),
      ),
    );

    expect(container.textContent).toContain('Dog');
    fireEvent.click(button(container, 'They match'));

    expect(svc.confirmSas).toHaveBeenCalledOnce();
  });

  it('dismisses and navigates to /rooms when done (routed, no returnTo)', async () => {
    const { svc, router, container } = await renderPage(
      signal(view({ stage: 'done' })),
    );

    fireEvent.click(button(container, 'Done'));

    expect(svc.dismiss).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  it('returns to the launch route (returnTo) when finishing a routed flow', async () => {
    const { router, container } = await renderPage(
      signal(view({ stage: 'done' })),
      { returnTo: '/settings' },
    );

    fireEvent.click(button(container, 'Done'));

    expect(router.navigateByUrl).toHaveBeenCalledWith('/settings', {
      replaceUrl: true,
    });
  });

  it('rejects an off-app returnTo and falls back to /rooms', async () => {
    const { router, container } = await renderPage(
      signal(view({ stage: 'done' })),
      { returnTo: '//evil.com' },
    );

    fireEvent.click(button(container, 'Done'));

    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  it('dismisses its own modal (and emits close) instead of navigating when modal', async () => {
    const { svc, router, close, container, fixture } = await renderPage(
      signal(view({ stage: 'done' })),
      { asModal: true },
    );
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));

    fireEvent.click(button(container, 'Done'));

    expect(svc.dismiss).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('does not touch the modal stack on the routed (non-modal) path', async () => {
    const { close, container } = await renderPage(
      signal(view({ stage: 'done' })),
    );

    fireEvent.click(button(container, 'Done'));

    expect(close).not.toHaveBeenCalled();
  });
});
