import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  AfterViewInit,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { QrCodeService } from '@trinity/platform-native/qr-code';
import { HlmButton } from '@trinity/helm/button';

type ScannerStatus = 'starting' | 'scanning' | 'error';

/** Reusable live-camera QR scanner which emits the decoded raw payload bytes. */
@Component({
  selector: 'trn-qr-scanner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './qr-scanner.component.html',
  styleUrl: './qr-scanner.component.scss',
  imports: [HlmButton],
})
export class QrScannerComponent implements AfterViewInit, OnDestroy {
  private readonly qrCode = inject(QrCodeService);
  private readonly preview =
    viewChild.required<ElementRef<HTMLVideoElement>>('preview');
  private readonly canvas =
    viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private stream: MediaStream | null = null;
  private animationFrame: number | null = null;
  private destroyed = false;
  private lastScanAt = 0;

  readonly scanned = output<Uint8ClampedArray>();
  readonly cancelled = output<void>();
  readonly status = signal<ScannerStatus>('starting');
  readonly error = signal<string | null>(null);

  ngAfterViewInit(): void {
    void this.start();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stop();
  }

  retry(): void {
    void this.start();
  }

  cancel(): void {
    this.stop();
    this.cancelled.emit();
  }

  private async start(): Promise<void> {
    this.stop();
    this.status.set('starting');
    this.error.set(null);
    try {
      const stream = await this.qrCode.openCamera();
      if (this.destroyed) {
        this.qrCode.closeCamera(stream);
        return;
      }
      this.stream = stream;
      const preview = this.preview().nativeElement;
      preview.srcObject = stream;
      await preview.play();
      this.status.set('scanning');
      this.animationFrame = requestAnimationFrame(this.scanFrame);
    } catch (error) {
      this.stop();
      this.status.set('error');
      this.error.set(cameraErrorMessage(error));
    }
  }

  private readonly scanFrame = (timestamp: number): void => {
    if (timestamp - this.lastScanAt >= 100) {
      this.lastScanAt = timestamp;
      const payload = this.readPayload();
      if (payload) {
        this.stop();
        this.scanned.emit(payload);
        return;
      }
    }
    this.animationFrame = requestAnimationFrame(this.scanFrame);
  };

  private readPayload(): Uint8ClampedArray | null {
    const preview = this.preview().nativeElement;
    if (preview.readyState < 2 || !preview.videoWidth || !preview.videoHeight) {
      return null;
    }
    const canvas = this.canvas().nativeElement;
    const scale = Math.min(1, 720 / preview.videoWidth);
    canvas.width = Math.round(preview.videoWidth * scale);
    canvas.height = Math.round(preview.videoHeight * scale);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(preview, 0, 0, canvas.width, canvas.height);
    return this.qrCode.decodeFrame(
      context.getImageData(0, 0, canvas.width, canvas.height),
    );
  }

  private stop(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.qrCode.closeCamera(this.stream);
    this.stream = null;
    const element = this.preview();
    if (element) {
      element.nativeElement.srcObject = null;
    }
  }
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'Camera access was denied. Allow camera access to scan the code.';
    }
    if (error.name === 'NotFoundError') {
      return 'No camera was found on this device.';
    }
  }
  return error instanceof Error
    ? error.message
    : 'The camera could not be opened.';
}
