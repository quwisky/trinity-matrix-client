import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  ImagePackManagementService,
  type ManagedImagePack,
} from '@trinity/data-access/media';
import { of, Subject } from 'rxjs';
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
  enabledUsage: ['sticker', 'emoticon'],
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
  const setEnabledUsage = vi.fn(() => of(void 0));
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
            setEnabledUsage,
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

  it('updates one enabled usage through an accessible checkbox', async () => {
    installed.set([available]);
    const fixture = TestBed.createComponent(ImagePacksSectionComponent);
    await fixture.whenStable();

    const sticker = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid=image-pack-usage-sticker]',
    ) as HTMLElement;
    sticker.click();
    await fixture.whenStable();

    expect(setEnabledUsage).toHaveBeenCalledWith(available, ['emoticon']);
  });

  it('moves focus to the installed heading after removing a row', async () => {
    installed.set([available]);
    const fixture = TestBed.createComponent(ImagePacksSectionComponent);
    await fixture.whenStable();

    await fixture.componentInstance.remove(available);
    await fixture.whenStable();

    expect(document.activeElement?.id).toBe('installed-packs-title');
  });

  it('prefills a routed room without joining or discovering automatically', async () => {
    TestBed.overrideProvider(ActivatedRoute, {
      useValue: {
        snapshot: {
          queryParamMap: convertToParamMap({ roomId: '!source:hs' }),
        },
      },
    });
    const fixture = TestBed.createComponent(ImagePacksSectionComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(discover).not.toHaveBeenCalled();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        '[data-testid=image-pack-source]',
      )?.value,
    ).toBe('!source:hs');
  });

  it('clears stale discovery results while a new lookup is in flight', async () => {
    const pending = new Subject<{
      roomId: string;
      roomName: string;
      packs: ManagedImagePack[];
    }>();
    discover.mockReturnValueOnce(pending);
    const fixture = TestBed.createComponent(ImagePacksSectionComponent);
    fixture.detectChanges();
    fixture.componentInstance.discovery.set({
      roomId: '!old:hs',
      roomName: 'Old room',
      packs: [available],
    });
    fixture.componentInstance.sourceForm.source().value.set('#new:hs');

    const finding = fixture.componentInstance.find();
    await Promise.resolve();

    expect(fixture.componentInstance.discovery()).toBeNull();
    pending.next({
      roomId: '!new:hs',
      roomName: 'New room',
      packs: [available],
    });
    pending.complete();
    await finding;
  });

  it('connects invalid source feedback to the input', async () => {
    const fixture = TestBed.createComponent(ImagePacksSectionComponent);
    fixture.detectChanges();
    await fixture.componentInstance.find();
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid=image-pack-source]',
    );
    const error = (fixture.nativeElement as HTMLElement).querySelector(
      '#image-pack-source-error',
    );
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toBe(
      'image-pack-source-error',
    );
    expect(error?.getAttribute('role')).toBe('alert');
  });
});
