import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  HOST_CAPABILITY_NEGOTIATOR,
  HostCapabilitiesService,
} from './host-capabilities.service';
import {
  HOST_OPERATIONS,
  unavailableHostManifest,
  type HostCapabilityManifest,
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

  describe('after a failed negotiation', () => {
    const failed = unavailableHostManifest('host-rejected');

    function setup(...answers: HostCapabilityManifest[]) {
      const negotiate = vi.fn<() => Observable<HostCapabilityManifest>>();
      for (const answer of answers) negotiate.mockReturnValueOnce(of(answer));
      TestBed.configureTestingModule({
        providers: [
          {
            provide: HOST_CAPABILITY_NEGOTIATOR,
            useValue: { manifest: negotiate },
          },
        ],
      });
      return { host: TestBed.inject(HostCapabilitiesService), negotiate };
    }

    it('holds a waiting reader until another reader gets the answer, without asking again', async () => {
      const answer = unavailableHostManifest('not-supported');
      const { host, negotiate } = setup(failed, failed, answer);
      const seen: HostCapabilityManifest[] = [];
      host.answered().subscribe((manifest) => seen.push(manifest));
      expect(negotiate).toHaveBeenCalledOnce();

      await firstValueFrom(host.manifest());
      expect(seen).toEqual([]);
      await firstValueFrom(host.manifest());

      expect(seen).toEqual([answer]);
      expect(negotiate).toHaveBeenCalledTimes(3);
    });

    it.each(['not-supported', 'protocol-mismatch'] as const)(
      'gives a waiting reader a %s answer at once',
      async (reason) => {
        const answer = unavailableHostManifest(reason);
        const { host } = setup(answer);

        await expect(firstValueFrom(host.answered())).resolves.toEqual(answer);
      },
    );

    it('tells of a recovery only when an answer follows a failure', async () => {
      const answer = unavailableHostManifest('not-supported');
      const { host } = setup(answer, failed, answer, answer);
      const recovered = vi.fn();
      host.recovered.subscribe(recovered);

      await firstValueFrom(host.manifest());
      await firstValueFrom(host.manifest());
      expect(recovered).not.toHaveBeenCalled();
      await firstValueFrom(host.manifest());
      await firstValueFrom(host.manifest());

      expect(recovered).toHaveBeenCalledOnce();
    });
  });
});
