import { describe, expect, it, vi } from 'vitest';

const { getPath, readFileSync, writeFileSync } = vi.hoisted(() => ({
  getPath: vi.fn(() => '/user-data'),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath } }));
vi.mock('node:fs', () => ({ readFileSync, writeFileSync }));

import * as path from 'node:path';
import { readWindowPrefs, writeWindowPrefs } from './window-prefs';

const io = (read: () => string) => ({
  readFile: vi.fn(read),
  writeFile: vi.fn(),
  path: '/user-data/window-prefs.json',
});

describe('readWindowPrefs', () => {
  it('reads a missing file as the default', () => {
    const missing = io(() => {
      throw new Error('ENOENT');
    });
    expect(readWindowPrefs(missing)).toEqual({ systemTitleBar: false });
  });

  it('reads corrupt JSON as the default', () => {
    expect(readWindowPrefs(io(() => '{nope'))).toEqual({
      systemTitleBar: false,
    });
  });

  it('reads a boolean systemTitleBar and rejects other values', () => {
    expect(readWindowPrefs(io(() => '{"systemTitleBar":true}'))).toEqual({
      systemTitleBar: true,
    });
    expect(readWindowPrefs(io(() => '{"systemTitleBar":"yes"}'))).toEqual({
      systemTitleBar: false,
    });
    expect(readWindowPrefs(io(() => '{}'))).toEqual({ systemTitleBar: false });
    expect(readWindowPrefs(io(() => '{"systemTitleBar":1}'))).toEqual({
      systemTitleBar: false,
    });
    expect(readWindowPrefs(io(() => 'null'))).toEqual({
      systemTitleBar: false,
    });
  });
});

describe('writeWindowPrefs', () => {
  it('writes the prefs as JSON to the userData path', () => {
    const fake = io(() => '');
    writeWindowPrefs({ systemTitleBar: true }, fake);
    expect(fake.writeFile).toHaveBeenCalledWith(
      '/user-data/window-prefs.json',
      '{"systemTitleBar":true}',
    );
  });
});

describe('default io', () => {
  const file = path.join('/user-data', 'window-prefs.json');

  it('reads <userData>/window-prefs.json', () => {
    readFileSync.mockReturnValueOnce('{"systemTitleBar":true}');
    expect(readWindowPrefs()).toEqual({ systemTitleBar: true });
    expect(getPath).toHaveBeenCalledWith('userData');
    expect(readFileSync).toHaveBeenCalledWith(file, 'utf8');
  });

  it('writes <userData>/window-prefs.json', () => {
    writeWindowPrefs({ systemTitleBar: true });
    expect(getPath).toHaveBeenCalledWith('userData');
    expect(writeFileSync).toHaveBeenCalledWith(file, '{"systemTitleBar":true}');
  });
});
