import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  ImagePackManagementService,
  type ManagedImagePack,
} from '@trinity/data-access/media';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePacksSectionComponent } from './image-packs-section.component';

const available: ManagedImagePack = {
  id: '!pack:hs\u0000fun',
  roomId: '!pack:hs',
  stateKey: 'fun',
  name: 'Fun pack',
  roomName: 'Pack room',
  attribution: 'Pack authors',
  imageCount: 2,
  usage: ['sticker', 'emoticon'],
  eventType: 'stable',
  status: 'available',
};

describe('ImagePacksSectionComponent', () => {
  const installed = signal<readonly ManagedImagePack[]>([]);
  const discover = vi.fn(() =>
    of({ roomId: '!pack:hs', roomName: 'Pack room', packs: [available] }),
  );
  const install = vi.fn(() => of(void 0));
  const uninstall = vi.fn(() => of(void 0));
  const confirm = vi.fn(async () => true);

  beforeEach(() => {
    installed.set([]);
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [ImagePacksSectionComponent],
      providers: [
        {
          provide: ImagePackManagementService,
          useValue: {
            installed: installed.asReadonly(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            discover,
            install,
            uninstall,
          },
        },
        { provide: TrnAlertService, useValue: { confirm } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap({}) },
          },
        },
      ],
    });
  });

  it('renders broken installed references with a remove action', async () => {
    installed.set([{ ...available, usage: [], status: 'unavailable' }]);
    const fixture = TestBed.createComponent(ImagePacksSectionComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('source room is not available');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid=remove-image-pack]',
      ),
    ).not.toBeNull();
  });

  it('discovers and installs one selected state key', async () => {
    const fixture = TestBed.createComponent(ImagePacksSectionComponent);
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid=image-pack-source]',
    ) as HTMLInputElement;
    input.value = '#packs:hs';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    await fixture.componentInstance.find();
    fixture.detectChanges();
    expect(discover).toHaveBeenCalledWith('#packs:hs');
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid=available-image-pack]',
      ),
    ).toHaveLength(1);

    await fixture.componentInstance.install(available);
    expect(install).toHaveBeenCalledWith(available);
    expect(fixture.componentInstance.notice()).toContain(
      'available in all rooms',
    );
  });

  it('explains removal scope before uninstalling', async () => {
    installed.set([available]);
    const fixture = TestBed.createComponent(ImagePacksSectionComponent);
    fixture.detectChanges();

    await fixture.componentInstance.remove(available);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('will not be deleted'),
      }),
    );
    expect(uninstall).toHaveBeenCalledWith(available);
  });
});
