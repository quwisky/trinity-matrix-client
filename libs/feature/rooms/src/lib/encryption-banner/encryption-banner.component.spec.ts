import { signal } from '@angular/core';
import {
  WORKSPACE_SYSTEM_STATUS,
  WorkspaceApplicationSurfaceService,
  type BannerPrompt,
  type SlotForecast,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { TrustService, type TrustStatus } from '@trinity/data-access/trust';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionBannerComponent } from './encryption-banner.component';

const status = signal<TrustStatus>('unknown');
const setupElsewhere = signal(false);
const slot = signal<'status' | 'encryption' | null>('encryption');
const slotReserved = signal(false);
const prompt = signal<BannerPrompt | null>(null);
const open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
  of({ kind: 'presented' as const, surface: request.surface }),
);

/** Render the banner with the real dialog service and mocked collaborators. */
function renderBanner() {
  return render(EncryptionBannerComponent, {
    providers: [
      MockProvider(TrustService, {
        status: status.asReadonly(),
        recoverySetupElsewhere: setupElsewhere.asReadonly(),
      }),
      MockProvider(WorkspaceApplicationSurfaceService, { open }),
      {
        provide: WORKSPACE_SYSTEM_STATUS,
        useValue: {
          hasProblems: signal(false),
          show: vi.fn(),
          bannerSlot: slot,
          bannerSlotReserved: slotReserved,
          bannerPrompt: prompt,
        },
      },
    ],
  });
}

beforeEach(() => {
  status.set('unknown');
  setupElsewhere.set(false);
  slot.set('encryption');
  slotReserved.set(false);
  prompt.set(null);
  open.mockClear();
});

/** The slot holds a prompt the live status confirms. */
function show(kind: SlotForecast): void {
  prompt.set({ kind, placeholder: false });
}

/** The slot holds a prompt's space only: a forecast, or a held prompt gone stale. */
function hold(kind: SlotForecast): void {
  prompt.set({ kind, placeholder: true });
}

function clickAction(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  fireEvent.click(button as HTMLElement);
}

describe('EncryptionBannerComponent', () => {
  it('renders nothing while the slot holds no encryption prompt', async () => {
    const { fixture, container } = await renderBanner();
    expect(container.querySelector('.banner')).toBeNull();

    status.set('ready');
    fixture.detectChanges();
    expect(container.querySelector('.banner')).toBeNull();
  });

  it('mirrors the prompt in an always-mounted live region', async () => {
    const { container, fixture } = await renderBanner();
    const liveRegion = () => container.querySelector('.sr-only[role="status"]');

    // Persistent and empty while there's nothing to prompt: a role="status" region
    // must exist before its text changes to be reliably announced, so the message is
    // mirrored here rather than only inside the @if banner.
    expect(liveRegion()).not.toBeNull();
    expect(liveRegion()?.textContent?.trim()).toBe('');

    status.set('needs-setup');
    show('needs-setup');
    fixture.detectChanges();

    expect(liveRegion()?.textContent).toContain('Set up encryption');
  });

  it('yields to the limited-capability banner so only one global banner shows', async () => {
    status.set('needs-setup');
    show('needs-setup');
    const { fixture, container } = await renderBanner();
    expect(container.querySelector('trn-banner')).not.toBeNull();

    slot.set('status');
    prompt.set(null);
    fixture.detectChanges();
    expect(container.querySelector('trn-banner')).toBeNull();
  });

  it('keeps its own height unless the notice it may replace has held the slot', async () => {
    show('needs-setup');
    const { fixture, container } = await renderBanner();
    const placement = () =>
      container.querySelector('trn-banner')?.getAttribute('data-placement');

    // Arriving in an empty slot replaces nothing, so it reserves nothing.
    expect(placement()).toBe('inline');

    // Once the two-action notice has held the slot, the prompt keeps its height.
    slotReserved.set(true);
    fixture.detectChanges();
    expect(placement()).toBe('global');
  });

  it('offers a single setup action as a semantic trust surface', async () => {
    show('needs-setup');
    const { container } = await renderBanner();

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(container.textContent).toContain('Set up encryption');

    clickAction(container, 'Set up');
    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'setup' },
    });
  });

  it('lists both recovery-key and verify actions for needs-recovery', async () => {
    show('needs-recovery');
    const { container } = await renderBanner();

    const labels = [...container.querySelectorAll('button')].map(
      (b: HTMLElement) => b.textContent?.trim(),
    );
    expect(labels).toEqual(['Use recovery key', 'Verify with another device']);
  });

  it('opens unlock and verify through the same semantic presenter', async () => {
    show('needs-recovery');
    const { container } = await renderBanner();

    clickAction(container, 'Use recovery key');
    clickAction(container, 'Verify with another device');
    expect(open).toHaveBeenNthCalledWith(1, {
      surface: { kind: 'trust', flow: 'unlock' },
    });
    expect(open).toHaveBeenNthCalledWith(2, {
      surface: { kind: 'trust', flow: 'verify' },
    });
  });

  it('offers verification, never setup, when the identity lives on another device', async () => {
    show('needs-verification');
    const { container } = await renderBanner();

    expect(container.querySelector('trn-banner')?.textContent).toContain(
      'verify it with one of your other devices',
    );
    const labels = [...container.querySelectorAll('trn-banner button')].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).toEqual(['Verify with another device']);

    clickAction(container, 'Verify with another device');
    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'verify' },
    });
  });

  it('sends a verified device to the other device for recovery, never to setup', async () => {
    show('setup-elsewhere');
    const { container } = await renderBanner();

    expect(container.querySelector('trn-banner')?.textContent).toContain(
      'Set up recovery on the device where you first set up encryption.',
    );
    // The banner cannot be dismissed, so its only action must not be destructive: the
    // reset stays in Security settings, behind its typed confirmation.
    const labels = [...container.querySelectorAll('trn-banner button')].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).toEqual(['Security settings']);

    clickAction(container, 'Security settings');
    expect(open).toHaveBeenCalledExactlyOnceWith({
      surface: { kind: 'settings', section: 'security' },
    });
  });

  describe('while the slot is held for a forecast prompt', () => {
    beforeEach(() => {
      status.set('unknown');
      slot.set('encryption');
      hold('needs-recovery');
    });

    it('lays out the forecast prompt without showing, announcing or enabling it', async () => {
      const { container } = await renderBanner();
      const banner = container.querySelector('trn-banner')!;
      expect(banner).not.toBeNull();
      expect(banner.closest('[data-forecast]')).not.toBeNull();
      expect(banner.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(banner.closest('[inert]')).not.toBeNull();
      expect(banner.textContent).toContain('unlock your encrypted messages');
      // Not in the accessibility tree.
      expect(
        screen.queryByRole('button', { name: 'Use recovery key' }),
      ).toBeNull();
      expect(
        container.querySelector('[role="status"]')!.textContent!.trim(),
      ).toBe('');
    });

    it('reveals the same banner in place when the live status confirms it', async () => {
      const { container, fixture } = await renderBanner();
      const before = container.querySelector('trn-banner');
      expect(before).not.toBeNull();

      status.set('needs-recovery');
      show('needs-recovery');
      fixture.detectChanges();

      const after = container.querySelector('trn-banner');
      // The same node, not a new one in the same place: nothing is laid out again.
      expect(after).toBe(before);
      expect(after!.closest('[data-forecast]')).toBeNull();
      expect(after!.closest('[aria-hidden="true"]')).toBeNull();
      expect(after!.closest('[inert]')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Use recovery key' }),
      ).toBeTruthy();
      expect(container.querySelector('[role="status"]')!.textContent).toContain(
        'unlock your encrypted messages',
      );
    });

    it('shows the setup-elsewhere guidance for that forecast', async () => {
      hold('setup-elsewhere');
      const { container } = await renderBanner();
      const banner = container.querySelector('trn-banner')!;

      expect(banner.closest('[data-forecast]')).not.toBeNull();
      expect(banner.textContent).toContain(
        'Set up recovery on the device where you first set up encryption.',
      );
      const labels = [...banner.querySelectorAll('button')].map((button) =>
        button.textContent?.trim(),
      );
      expect(labels).toEqual(['Security settings']);
    });

    it('keeps the forecast prompt’s buttons out of reach until it is confirmed', async () => {
      const { container, fixture } = await renderBanner();
      const buttons = () => [
        ...container.querySelectorAll<HTMLButtonElement>('trn-banner button'),
      ];

      // jsdom does not apply inert to focus, so assert the attribute the browser
      // applies it from: every button sits inside an inert subtree.
      expect(buttons().length).toBe(2);
      for (const button of buttons()) {
        expect(button.closest('[inert]')).not.toBeNull();
      }

      status.set('needs-recovery');
      show('needs-recovery');
      fixture.detectChanges();

      expect(buttons().length).toBe(2);
      for (const button of buttons()) {
        expect(button.closest('[inert]')).toBeNull();
      }
    });

    it('keeps the live region empty for the forecast and fills it once it is real', async () => {
      const { container, fixture } = await renderBanner();
      const liveRegion = () =>
        container.querySelector('.sr-only[role="status"]');

      // The region is mounted from the start, so the confirmed message is a change to
      // an existing region and is announced; the forecast itself is never announced.
      expect(liveRegion()).not.toBeNull();
      expect(liveRegion()!.textContent!.trim()).toBe('');

      status.set('needs-recovery');
      show('needs-recovery');
      fixture.detectChanges();

      expect(liveRegion()!.textContent).toContain(
        'unlock your encrypted messages',
      );
    });

    it('removes a forecast the live status contradicts at once when nothing is pressed', async () => {
      const { container, fixture } = await renderBanner();
      expect(container.querySelector('trn-banner')).not.toBeNull();

      // The slot owner drops the prompt as soon as the live status is ready.
      status.set('ready');
      slot.set(null);
      prompt.set(null);
      fixture.detectChanges();

      expect(container.querySelector('trn-banner')).toBeNull();
    });

    it('keeps a contradicted forecast as the same inert placeholder while pressed, then removes it on release', async () => {
      const { container, fixture } = await renderBanner();
      const before = container.querySelector('trn-banner');
      const liveRegion = () =>
        container.querySelector('.sr-only[role="status"]')!;

      // Pressed: the live status is ready, but the slot and its content are held.
      status.set('ready');
      fixture.detectChanges();

      const held = container.querySelector('trn-banner');
      expect(held, 'the placeholder stays under the press').toBe(before);
      expect(held!.textContent).toContain('unlock your encrypted messages');
      expect(held!.closest('[data-forecast]')).not.toBeNull();
      expect(held!.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(held!.closest('[inert]')).not.toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Use recovery key' }),
      ).toBeNull();
      expect(liveRegion().textContent!.trim()).toBe('');

      // Released: the slot owner applies the change.
      slot.set(null);
      prompt.set(null);
      fixture.detectChanges();

      expect(container.querySelector('trn-banner')).toBeNull();
      expect(liveRegion().textContent!.trim()).toBe('');
    });
  });

  describe('while a press holds a shown prompt the live status no longer supports', () => {
    it('hides it as an inert placeholder of the same kind, then removes it on release', async () => {
      status.set('needs-setup');
      show('needs-setup');
      const { container, fixture } = await renderBanner();
      const before = container.querySelector('trn-banner');
      const liveRegion = () =>
        container.querySelector('.sr-only[role="status"]')!;
      expect(screen.getByRole('button', { name: 'Set up' })).toBeTruthy();
      expect(liveRegion().textContent).toContain('Set up encryption');

      // Pressed: the prompt turned ready. It keeps its space but is no longer shown,
      // announced or actionable.
      status.set('ready');
      hold('needs-setup');
      fixture.detectChanges();

      const held = container.querySelector('trn-banner');
      expect(held, 'same node, same height').toBe(before);
      expect(held!.textContent).toContain('Set up encryption');
      expect(held!.closest('[data-forecast]')).not.toBeNull();
      expect(held!.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(held!.closest('[inert]')).not.toBeNull();
      expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
      expect(liveRegion().textContent!.trim()).toBe('');

      // Released.
      slot.set(null);
      prompt.set(null);
      fixture.detectChanges();
      expect(container.querySelector('trn-banner')).toBeNull();
    });

    it('never announces the held kind, only the prompt that replaces it on release', async () => {
      status.set('needs-setup');
      show('needs-setup');
      const { container, fixture } = await renderBanner();
      const liveRegion = () =>
        container.querySelector('.sr-only[role="status"]')!;

      // Pressed: the live status changed kind; the held kind stays, unannounced.
      status.set('needs-recovery');
      hold('needs-setup');
      fixture.detectChanges();
      expect(container.querySelector('trn-banner')!.textContent).toContain(
        'Set up encryption',
      );
      expect(liveRegion().textContent!.trim()).toBe('');

      // Released: the live prompt replaces it and is announced.
      show('needs-recovery');
      fixture.detectChanges();
      expect(liveRegion().textContent).toContain(
        'unlock your encrypted messages',
      );
      expect(liveRegion().textContent).not.toContain('Set up encryption');
    });
  });
});
