import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  HOST_CAPABILITY_NEGOTIATOR,
  HostCapabilitiesService,
} from './host-capabilities.service';
import {
  HOST_OPERATIONS,
  unavailableHostManifest,
} from './host-capability.models';

describe('HostCapabilitiesService', () => {
  it('covers every agreed operation and reports an unwired host explicitly', async () => {
    const manifest = await firstValueFrom(
      TestBed.inject(HostCapabilitiesService).manifest(),
    );

    expect(Object.keys(manifest.operations).sort()).toEqual(
      [...HOST_OPERATIONS].sort(),
    );
    expect(Object.values(manifest.operations)).toEqual(
      HOST_OPERATIONS.map(() => ({
        kind: 'unavailable',
        reason: 'not-implemented',
      })),
    );
  });

  it('keeps negotiation cold and finite', async () => {
    const negotiate = vi.fn(() => of(unavailableHostManifest('not-supported')));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HOST_CAPABILITY_NEGOTIATOR,
          useValue: { manifest: negotiate },
        },
      ],
    });
    const command = TestBed.inject(HostCapabilitiesService).manifest();

    expect(negotiate).not.toHaveBeenCalled();
    await firstValueFrom(command);
    expect(negotiate).toHaveBeenCalledOnce();
  });
});
