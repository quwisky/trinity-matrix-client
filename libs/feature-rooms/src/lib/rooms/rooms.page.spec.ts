import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MenuController, ToastController } from '@ionic/angular/standalone';
import {
  AuthService,
  CryptoService,
  MatrixClientService,
  RoomsService,
  TimelineService,
} from '@trinity/core';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomsPage } from './rooms.page';

// Instantiate the page through DI without rendering (the shell template pulls in
// many child components); we only exercise the action handlers' error feedback.
describe('RoomsPage action error feedback', () => {
  let edit: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let sendMedia: ReturnType<typeof vi.fn>;

  function build(): RoomsPage {
    const present = vi.fn().mockResolvedValue(undefined);
    create = vi.fn().mockResolvedValue({ present });
    edit = vi.fn();
    sendMedia = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        { provide: RoomsService, useValue: { connect: vi.fn() } },
        {
          provide: TimelineService,
          useValue: {
            edit,
            sendMedia,
            redact: vi.fn(() => of(undefined)),
            toggleReaction: vi.fn(() => of(undefined)),
            reply: vi.fn(() => of(undefined)),
            close: vi.fn(),
          },
        },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs' },
          },
        },
        {
          provide: CryptoService,
          useValue: { connect: vi.fn(), status: signal('ready') },
        },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: MenuController, useValue: { close: vi.fn() } },
        { provide: ToastController, useValue: { create } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('shows a danger toast when an edit fails', () => {
    const page = build();
    edit.mockReturnValue(throwError(() => new Error('nope')));

    page.onEdit({ id: '$1', body: 'x' });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'danger' }),
    );
  });

  it('does not toast when the action succeeds', () => {
    const page = build();
    edit.mockReturnValue(of(undefined));

    page.onEdit({ id: '$1', body: 'x' });

    expect(create).not.toHaveBeenCalled();
  });

  const pngFile = () =>
    new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' });

  it('drives uploadProgress 0 → fraction → null over a successful media send', () => {
    const page = build(); // build() (re)creates the sendMedia mock — set it after
    const stream = new Subject<void>();
    let progressCb: ((fraction: number) => void) | undefined;
    sendMedia.mockImplementation(
      (_file: File, cb?: (fraction: number) => void) => {
        progressCb = cb;
        return stream.asObservable();
      },
    );

    page.onSendMedia(pngFile());
    expect(page.uploadProgress()).toBe(0); // reset to 0 on start

    progressCb?.(0.5);
    expect(page.uploadProgress()).toBe(0.5); // tracks the upload fraction

    stream.complete();
    expect(page.uploadProgress()).toBeNull(); // cleared by finalize on success
    expect(create).not.toHaveBeenCalled(); // no error toast
  });

  it('clears uploadProgress and toasts when a media send fails', () => {
    const page = build();
    const stream = new Subject<void>();
    sendMedia.mockReturnValue(stream.asObservable());

    page.onSendMedia(pngFile());
    expect(page.uploadProgress()).toBe(0);

    stream.error(new Error('upload failed'));

    expect(page.uploadProgress()).toBeNull(); // finalize clears on error too
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'danger' }),
    );
  });
});
