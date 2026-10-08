import { describe, expect, it } from 'vitest';
import { sameWorkspaceApplicationSurface } from './workspace-surface.models';

describe('sameWorkspaceApplicationSurface', () => {
  it('matches System status by its open section', () => {
    expect(
      sameWorkspaceApplicationSurface(
        { kind: 'system-status', section: 'support' },
        { kind: 'system-status', section: 'support' },
      ),
    ).toBe(true);
    expect(
      sameWorkspaceApplicationSurface(
        { kind: 'system-status', section: 'support' },
        { kind: 'system-status', section: 'overview' },
      ),
    ).toBe(false);
    expect(
      sameWorkspaceApplicationSurface(
        { kind: 'system-status', section: 'support' },
        { kind: 'settings', section: 'support' },
      ),
    ).toBe(false);
  });
});
