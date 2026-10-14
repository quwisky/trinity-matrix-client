import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_FILE_EXPORT_OPERATION,
  HOST_LIFECYCLE_OPERATION,
  HOST_UPDATES_OPERATION,
  HostAuthenticationHandoffService,
  HostFileExportService,
  HostLifecycleService,
  HostUpdatesService,
} from './host-operation.services';

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
