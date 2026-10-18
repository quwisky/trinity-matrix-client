import { TestBed } from '@angular/core/testing';
import { NEVER, Subject, firstValueFrom, of, throwError, toArray } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_DEEP_LINKS_OPERATION,
  HOST_FILE_EXPORT_OPERATION,
  HOST_LIFECYCLE_OPERATION,
  HOST_UPDATES_OPERATION,
  HOST_USER_PRESENCE_OPERATION,
  HostAuthenticationHandoffService,
  HostDeepLinksService,
  HostFileExportService,
  HostLifecycleService,
  HostLockIntegrationService,
  HOST_SCREEN_PRIVACY_OPERATION,
  HostScreenPrivacyService,
  HostUpdatesService,
  HostUserPresenceService,
  NO_USER_PRESENCE,
} from './host-operation.services';
import { HostSystemUiService } from './host-system-ui.service';
import type { HostOperationOutcome } from './host-capability.models';

describe('remaining host operation services', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reports unwired file export and updates unavailable and completes no lifecycle event', async () => {
    const files = TestBed.inject(HostFileExportService);
    const lifecycle = TestBed.inject(HostLifecycleService);
    const updates = TestBed.inject(HostUpdatesService);
    const lifecycleComplete = vi.fn();

    lifecycle.events.subscribe({ complete: lifecycleComplete });

    await expect(firstValueFrom(files.support())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(
      firstValueFrom(
        files.save({ bytes: new Blob(['x']), filename: 'example.txt' }),
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(firstValueFrom(updates.check())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(lifecycleComplete).toHaveBeenCalledOnce();
  });

  it('keeps commands cold and delegates only through the narrow contracts', async () => {
    const fileSave = vi.fn(() => of({ kind: 'completed' as const }));
    const updateCheck = vi.fn(() =>
      of({ kind: 'unavailable', reason: 'not-implemented' } as const),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_FILE_EXPORT_OPERATION,
          useValue: {
            support: () => of({ kind: 'supported' as const }),
            save: fileSave,
          },
        },
        {
          provide: HOST_LIFECYCLE_OPERATION,
          useValue: { events: of({ kind: 'active' as const }) },
        },
        { provide: HOST_UPDATES_OPERATION, useValue: { check: updateCheck } },
      ],
    });
    const files = TestBed.inject(HostFileExportService);
    const updates = TestBed.inject(HostUpdatesService);
    const fileCommand = files.save({
      bytes: new Blob(['x']),
      filename: 'example.txt',
    });
    const updateCommand = updates.check();

    expect(fileSave).not.toHaveBeenCalled();
    expect(updateCheck).not.toHaveBeenCalled();
    await expect(firstValueFrom(fileCommand)).resolves.toEqual({
      kind: 'completed',
    });
    await expect(firstValueFrom(updateCommand)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-implemented',
    });
    await expect(
      firstValueFrom(TestBed.inject(HostLifecycleService).events),
    ).resolves.toEqual({ kind: 'active' });
  });
});

describe('HostAuthenticationHandoffService device display name', () => {
  afterEach(() => TestBed.resetTestingModule());

  const adapter = {
    callback: () => ({
      url: 'https://app/sso-callback',
      applicationType: 'web' as const,
    }),
    open: () => of({ kind: 'completed' as const }),
  };

  it('offers no private callback when no host adapter is wired', () => {
    expect(
      TestBed.inject(
        HostAuthenticationHandoffService,
      ).privateCallbackSupported(),
    ).toBe(false);
  });

  it('names devices "Trinity" when no host adapter is wired', () => {
    expect(
      TestBed.inject(HostAuthenticationHandoffService).deviceDisplayName(),
    ).toBe('Trinity');
  });

  it('names devices "Trinity" when the host has no name of its own', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: HOST_AUTHENTICATION_HANDOFF_OPERATION, useValue: adapter },
      ],
    });
    expect(
      TestBed.inject(HostAuthenticationHandoffService).deviceDisplayName(),
    ).toBe('Trinity');
  });

  it("uses the host's own name", () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_AUTHENTICATION_HANDOFF_OPERATION,
          useValue: { ...adapter, deviceDisplayName: () => 'Trinity Next' },
        },
      ],
    });
    expect(
      TestBed.inject(HostAuthenticationHandoffService).deviceDisplayName(),
    ).toBe('Trinity Next');
  });
});

describe('app lock host services without an adapter', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reports no system prompt and no PIN, and verifies nothing', async () => {
    const presence = TestBed.inject(HostUserPresenceService);
    await expect(firstValueFrom(presence.support())).resolves.toEqual(
      NO_USER_PRESENCE,
    );
    await expect(
      firstValueFrom(presence.verify({ reason: 'Unlock Trinity' })),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
    await expect(firstValueFrom(presence.verifyPin('1234'))).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(firstValueFrom(presence.setPin('1234'))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(firstValueFrom(presence.clearPin())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('has no lock requests and accepts no state or cover', async () => {
    const lock = TestBed.inject(HostLockIntegrationService);
    await expect(
      firstValueFrom(lock.requests.pipe(toArray())),
    ).resolves.toEqual([]);
    await expect(
      firstValueFrom(
        lock.setState({ enabled: true, locked: true, accelerator: null }),
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
    await expect(firstValueFrom(lock.coverPainted())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('has no screen privacy', async () => {
    const privacy = TestBed.inject(HostScreenPrivacyService);
    await expect(firstValueFrom(privacy.support())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(firstValueFrom(privacy.set(true))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(firstValueFrom(privacy.dismissPresented())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('passes on what the host’s app-switcher cover does', async () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_SCREEN_PRIVACY_OPERATION,
          useValue: {
            support: () => of({ kind: 'supported', blocksCapture: true }),
            set: () => NEVER,
            dismissPresented: () => NEVER,
          },
        },
      ],
    });
    await expect(
      firstValueFrom(TestBed.inject(HostScreenPrivacyService).support()),
    ).resolves.toEqual({ kind: 'supported', blocksCapture: true });
  });

  it('counts a system prompt as Trinity’s own system UI while it is open', () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_USER_PRESENCE_OPERATION,
          useValue: {
            support: () => of(NO_USER_PRESENCE),
            verify: () => NEVER,
            setPin: () => NEVER,
            verifyPin: () => NEVER,
            clearPin: () => NEVER,
          },
        },
      ],
    });
    const ui = TestBed.inject(HostSystemUiService);
    const prompt = TestBed.inject(HostUserPresenceService)
      .verify({ reason: 'Unlock Trinity' })
      .subscribe();
    expect(ui.active()).toBe(true);
    prompt.unsubscribe();
    expect(ui.active()).toBe(false);
  });

  it('counts a native save sheet as Trinity’s own system UI', () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_FILE_EXPORT_OPERATION,
          useValue: { support: () => NEVER, save: () => NEVER },
        },
      ],
    });
    const ui = TestBed.inject(HostSystemUiService);
    const save = TestBed.inject(HostFileExportService)
      .save({ bytes: new Blob(['x']), filename: 'x.txt' })
      .subscribe();
    expect(ui.active()).toBe(true);
    save.unsubscribe();
    expect(ui.active()).toBe(false);
  });
});

describe('HostAuthenticationHandoffService sign-in sheet', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(
    options: {
      /** The host shows sign-in in a sheet of its own (iOS, Android). */
      sheet?: boolean;
      opened?: HostOperationOutcome;
      /** The host's open fails outright instead of reporting an outcome. */
      openFails?: boolean;
    } = {},
  ) {
    const sheetClosed = new Subject<void>();
    const received = new Subject<{ readonly url: string }>();
    const lifecycle = new Subject<{ readonly kind: 'active' | 'background' }>();
    const closeAuthentication = vi.fn(() => of({ kind: 'completed' as const }));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_AUTHENTICATION_HANDOFF_OPERATION,
          useValue: {
            callback: () => ({
              url: 'dev.trinityproject.trinity:/sso-callback',
              applicationType: 'native' as const,
            }),
            open: () =>
              options.openFails
                ? throwError(() => new Error('browser unavailable'))
                : of(options.opened ?? { kind: 'completed' as const }),
            ...(options.sheet === false
              ? {}
              : { sheetClosed: sheetClosed.asObservable() }),
          },
        },
        {
          provide: HOST_DEEP_LINKS_OPERATION,
          useValue: {
            deepLinkSupport: () => of({ kind: 'supported' as const }),
            received: received.asObservable(),
            closeAuthentication,
          },
        },
        {
          provide: HOST_LIFECYCLE_OPERATION,
          useValue: { events: lifecycle.asObservable() },
        },
      ],
    });
    const ui = TestBed.inject(HostSystemUiService);
    const handoff = TestBed.inject(HostAuthenticationHandoffService);
    const deepLinks = TestBed.inject(HostDeepLinksService);
    // The application listens for links for its whole lifetime.
    deepLinks.received.subscribe();
    const open = () =>
      handoff
        .open({ url: 'https://account.example/authorize' })
        .subscribe({ error: () => undefined });
    return { ui, deepLinks, sheetClosed, received, lifecycle, open };
  }

  it('counts the sign-in sheet as Trinity’s own system UI until the callback arrives', () => {
    const { ui, received, open } = setup();
    open();
    // The host's open resolves as soon as the sheet shows; the sheet is still up.
    expect(ui.active()).toBe(true);
    received.next({ url: 'dev.trinityproject.trinity:/sso-callback?code=a' });
    expect(ui.active()).toBe(false);
  });

  it('stops counting when Trinity closes the sheet', () => {
    const { ui, deepLinks, open } = setup();
    open();
    expect(ui.active()).toBe(true);
    deepLinks.closeAuthentication().subscribe();
    expect(ui.active()).toBe(false);
  });

  it('stops counting when the person closes the sheet', () => {
    const { ui, sheetClosed, open } = setup();
    open();
    expect(ui.active()).toBe(true);
    sheetClosed.next();
    expect(ui.active()).toBe(false);
  });

  it('releases a sheet whose end was missed once the app is back in the foreground', () => {
    const { ui, lifecycle, open } = setup();
    open();
    lifecycle.next({ kind: 'background' });
    expect(ui.active()).toBe(true);
    lifecycle.next({ kind: 'active' });
    expect(ui.active()).toBe(false);
  });

  it('counts a second sign-in once, ending with its own sheet', () => {
    const { ui, sheetClosed, open } = setup();
    open();
    open();
    expect(ui.active()).toBe(true);
    sheetClosed.next();
    expect(ui.active()).toBe(false);
  });

  it('counts nothing when the sheet could not open', () => {
    const { ui, open } = setup({
      opened: {
        kind: 'rejected',
        diagnostic: { code: 'authentication-handoff-failed' },
      },
    });
    open();
    expect(ui.active()).toBe(false);
  });

  it('counts nothing when opening the sheet fails', () => {
    const { ui, open } = setup({ openFails: true });
    open();
    expect(ui.active()).toBe(false);
  });

  it('counts nothing for a browser outside Trinity, as on desktop', () => {
    const { ui, open } = setup({ sheet: false });
    open();
    expect(ui.active()).toBe(false);
  });
});
