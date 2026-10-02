import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const electronRoot = join(import.meta.dirname, '..');

// Electron names the user-data folder (sessions, keys, the safeStorage-encrypted secure
// store) after `productName`, falling back to `name`. Renaming it after a release
// strands every user's data, so it is pinned to the packaged product name here.
describe('desktop app identity', () => {
  it('names the runtime app, and so its data folder, after the product', () => {
    const pkg = JSON.parse(
      readFileSync(join(electronRoot, 'package.json'), 'utf8'),
    );
    const builder = readFileSync(
      join(electronRoot, 'electron-builder.yml'),
      'utf8',
    );
    expect(pkg.productName).toBe('Trinity');
    expect(builder).toMatch(/^productName: Trinity$/m);
    // The workspace package name stays: Nx and pnpm address the project by it.
    expect(pkg.name).toBe('trinity-desktop');
  });

  it('describes the app for users, since Linux menus and Windows file properties show it', () => {
    const pkg = JSON.parse(
      readFileSync(join(electronRoot, 'package.json'), 'utf8'),
    );
    expect(pkg.description).toBe('End-to-end encrypted Matrix client');
  });
});
