import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_APPLICATION_SURFACE_PRESENTER,
  WorkspaceApplicationSurfaceService,
} from './workspace-application-surface.service';

const request = {
  surface: { kind: 'settings', section: 'security' },
} as const;

describe('WorkspaceApplicationSurfaceService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is cold and delegates the typed request to the host presenter', async () => {
    const present = vi.fn(() =>
      of({ kind: 'presented' as const, surface: request.surface }),
    );
    const service = TestBed.configureTestingModule({
      providers: [
        {
          provide: WORKSPACE_APPLICATION_SURFACE_PRESENTER,
          useValue: { present },
        },
      ],
    }).inject(WorkspaceApplicationSurfaceService);
    const command = service.open(request);

    expect(present).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'presented',
      surface: request.surface,
    });
    expect(present).toHaveBeenCalledWith(request);
  });

  it('reports an unavailable surface when the composition root has no adapter', async () => {
    const service = TestBed.configureTestingModule({}).inject(
      WorkspaceApplicationSurfaceService,
    );

    await expect(firstValueFrom(service.open(request))).resolves.toEqual({
      kind: 'unavailable',
      surface: request.surface,
    });
  });
});
