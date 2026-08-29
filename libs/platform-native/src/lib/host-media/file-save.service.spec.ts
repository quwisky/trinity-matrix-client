import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FileSaveService } from './file-save.service';

// Capacitor + the native plugins are unavailable under jsdom; mock them so both
// the web fallback and the native write+share branch can be exercised.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => true),
  },
}));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: vi.fn(), rmdir: vi.fn() },
  Directory: { Cache: 'CACHE' },
}));
vi.mock('@capacitor/share', () => ({
  Share: { share: vi.fn() },
}));

const isNative = Capacitor.isNativePlatform as unknown as Mock;
const writeFile = Filesystem.writeFile as unknown as Mock;
const rmdir = Filesystem.rmdir as unknown as Mock;
const share = Share.share as unknown as Mock;

/** The basename a per-share path ('trinity-shared/<token>/<name>') ends with. */
const sharedBasename = (path: string) => path.split('/').pop();

function build(): FileSaveService {
  TestBed.configureTestingModule({ providers: [FileSaveService] });
  return TestBed.inject(FileSaveService);
}

describe('FileSaveService host adapter', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false);
    writeFile.mockReset().mockResolvedValue({ uri: 'file:///cache/pic.png' });
    rmdir.mockReset().mockResolvedValue(undefined);
    share.mockReset().mockResolvedValue(undefined);
  });

  describe('web fallback', () => {
    let origCreate: typeof URL.createObjectURL;
    let origRevoke: typeof URL.revokeObjectURL;
    let createObjectURL: Mock;
    let revokeObjectURL: Mock;

    beforeEach(() => {
      isNative.mockReturnValue(false);
      // jsdom doesn't implement the object-URL API.
      origCreate = URL.createObjectURL;
      origRevoke = URL.revokeObjectURL;
      createObjectURL = vi.fn(() => 'blob:dl');
      revokeObjectURL = vi.fn();
      URL.createObjectURL =
        createObjectURL as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL =
        revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    });

    afterEach(() => {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      vi.restoreAllMocks();
    });

    it('downloads via an <a download> link and revokes the object URL', async () => {
      const svc = build();
      expect(svc.nativeAvailable).toBe(false);
      // Capture the download attribute at click time (and stop jsdom navigation).
      let downloadName: string | undefined;
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          downloadName = this.download;
        },
      );

      await firstValueFrom(svc.save(new Blob(['x']), 'pic.png'));

      expect(downloadName).toBe('pic.png');
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:dl');
      // The native plugins are never touched on the web.
      expect(writeFile).not.toHaveBeenCalled();
      expect(share).not.toHaveBeenCalled();
    });
  });

  describe('native', () => {
    beforeEach(() => isNative.mockReturnValue(true));

    it('sweeps prior shares, writes to a per-share folder, then shares', async () => {
      const svc = build();
      expect(svc.nativeAvailable).toBe(true);

      await firstValueFrom(svc.save(new Blob(['hello']), 'pic.png'));

      // Previous shares are swept first so plaintext never lingers, but the file
      // for *this* share is left in place — deleting it now could truncate the
      // receiver's still-pending read (notably on Android).
      expect(rmdir).toHaveBeenCalledWith({
        path: 'trinity-shared',
        directory: 'CACHE',
        recursive: true,
      });
      expect(writeFile).toHaveBeenCalledTimes(1);
      const opts = writeFile.mock.calls[0][0];
      // A unique subfolder under the share dir, keeping a clean filename.
      expect(opts.path).toMatch(/^trinity-shared\/[^/]+\/pic\.png$/);
      expect(opts.directory).toBe('CACHE');
      expect(opts.recursive).toBe(true); // creates the per-share subfolder
      expect(typeof opts.data).toBe('string'); // base64, no data: prefix
      expect(opts.data).not.toContain(',');
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ files: ['file:///cache/pic.png'] }),
      );
    });

    it('reduces a path-bearing filename to a safe basename', async () => {
      const svc = build();

      await firstValueFrom(svc.save(new Blob(['x']), 'a/b\\c.png'));

      expect(sharedBasename(writeFile.mock.calls[0][0].path)).toBe('a_b_c.png');
    });

    it('falls back to "download" for empty or dot-only filenames', async () => {
      const svc = build();

      await firstValueFrom(svc.save(new Blob(['x']), '   '));
      expect(sharedBasename(writeFile.mock.calls[0][0].path)).toBe('download');

      await firstValueFrom(svc.save(new Blob(['x']), '..'));
      expect(sharedBasename(writeFile.mock.calls[1][0].path)).toBe('download');
    });

    it('gives each share its own folder so a sweep never hits a live file', async () => {
      const svc = build();

      await firstValueFrom(svc.save(new Blob(['x']), 'pic.png'));
      await firstValueFrom(svc.save(new Blob(['y']), 'pic.png'));

      const first = writeFile.mock.calls[0][0].path as string;
      const second = writeFile.mock.calls[1][0].path as string;
      expect(first).not.toBe(second); // distinct per-share tokens
      expect(rmdir).toHaveBeenCalledTimes(2); // each save sweeps prior shares
    });

    it('truncates an over-long filename while keeping its extension', async () => {
      const svc = build();

      await firstValueFrom(svc.save(new Blob(['x']), `${'a'.repeat(400)}.png`));

      const name = sharedBasename(writeFile.mock.calls[0][0].path) as string;
      expect(name.length).toBe(200);
      expect(name.endsWith('.png')).toBe(true);
    });

    it('swallows a user-cancelled share (not a failure), no immediate delete', async () => {
      share.mockRejectedValueOnce(new Error('Share canceled'));
      const svc = build();

      await expect(
        firstValueFrom(svc.save(new Blob(['x']), 'pic.png')),
      ).resolves.toBeUndefined();
      // The file is left for the next save's sweep — never deleted out from under
      // a receiver that may still be reading it.
      expect(writeFile).toHaveBeenCalledTimes(1);
    });

    it('propagates a genuine share failure', async () => {
      share.mockRejectedValueOnce(new Error('kaboom'));
      const svc = build();

      await expect(
        firstValueFrom(svc.save(new Blob(['x']), 'pic.png')),
      ).rejects.toThrow(/kaboom/);
    });
  });
});
