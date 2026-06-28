import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { VerificationService, type VerificationView } from '@trinity/core';
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

function configure(
  active: WritableSignal<VerificationView | null>,
  returnTo: string | null = null,
) {
  const svc = {
    active,
    startSelfVerification: vi.fn(() => of(undefined)),
    accept: vi.fn(() => of(undefined)),
    startSas: vi.fn(() => of(undefined)),
    confirmSas: vi.fn(() => of(undefined)),
    mismatchSas: vi.fn(() => of(undefined)),
    cancel: vi.fn(() => of(undefined)),
    dismiss: vi.fn(),
  };
  const router = { navigateByUrl: vi.fn() };
  const route = {
    snapshot: {
      queryParamMap: {
        get: (key: string) => (key === 'returnTo' ? returnTo : null),
      },
    },
  };
  TestBed.configureTestingModule({
    imports: [DeviceVerificationPage],
    providers: [
      { provide: VerificationService, useValue: svc },
      { provide: Router, useValue: router },
      { provide: ActivatedRoute, useValue: route },
    ],
  });
  return { svc, router };
}

function button(host: HTMLElement, text: string): HTMLElement {
  return [...host.querySelectorAll('ion-button')].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLElement;
}

describe('DeviceVerificationPage', () => {
  it('offers to start when nothing is in flight', () => {
    const { svc } = configure(signal(null));
    const fixture = TestBed.createComponent(DeviceVerificationPage);
    fixture.detectChanges();

    button(fixture.nativeElement, 'Start verification').click();

    expect(svc.startSelfVerification).toHaveBeenCalledOnce();
  });

  it('accepts an incoming request', () => {
    const { svc } = configure(
      signal(view({ stage: 'requested', incoming: true })),
    );
    const fixture = TestBed.createComponent(DeviceVerificationPage);
    fixture.detectChanges();

    button(fixture.nativeElement, 'Accept').click();

    expect(svc.accept).toHaveBeenCalledOnce();
  });

  it('shows the emoji and confirms on match', () => {
    const { svc } = configure(
      signal(
        view({ stage: 'sas-shown', emoji: [{ glyph: '🐶', name: 'Dog' }] }),
      ),
    );
    const fixture = TestBed.createComponent(DeviceVerificationPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Dog');
    button(fixture.nativeElement, 'They match').click();

    expect(svc.confirmSas).toHaveBeenCalledOnce();
  });

  it('dismisses and navigates to /rooms when done (routed, no returnTo)', () => {
    const { svc, router } = configure(signal(view({ stage: 'done' })));
    const fixture = TestBed.createComponent(DeviceVerificationPage);
    fixture.detectChanges();

    button(fixture.nativeElement, 'Done').click();

    expect(svc.dismiss).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  it('returns to the launch route (returnTo) when finishing a routed flow', () => {
    const { router } = configure(signal(view({ stage: 'done' })), '/settings');
    const fixture = TestBed.createComponent(DeviceVerificationPage);
    fixture.detectChanges();

    button(fixture.nativeElement, 'Done').click();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/settings', {
      replaceUrl: true,
    });
  });

  it('rejects an off-app returnTo and falls back to /rooms', () => {
    const { router } = configure(signal(view({ stage: 'done' })), '//evil.com');
    const fixture = TestBed.createComponent(DeviceVerificationPage);
    fixture.detectChanges();

    button(fixture.nativeElement, 'Done').click();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  it('emits close instead of navigating when shown as a modal', () => {
    const { svc } = configure(signal(view({ stage: 'done' })));
    const fixture = TestBed.createComponent(DeviceVerificationPage);
    fixture.componentRef.setInput('asModal', true);
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));
    fixture.detectChanges();

    button(fixture.nativeElement, 'Done').click();

    expect(svc.dismiss).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
  });
});
