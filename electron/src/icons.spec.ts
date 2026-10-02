import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSync } = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync }));
vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }));

import { iconCandidatePaths, resolveIconFile } from './icons';

describe('resolveIconFile', () => {
  // iconCandidatePaths() joins process.resourcesPath, which only Electron defines.
  beforeAll(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: '/resources',
      configurable: true,
    });
  });
  beforeEach(() => existsSync.mockReset());

  it('returns the first candidate that exists', () => {
    const [, second] = iconCandidatePaths('icon.png');
    existsSync.mockImplementation((path: string) => path === second);
    expect(resolveIconFile('icon.png')).toBe(second);
  });

  it('returns undefined when no candidate exists', () => {
    existsSync.mockReturnValue(false);
    expect(resolveIconFile('icon.png')).toBeUndefined();
  });
});
