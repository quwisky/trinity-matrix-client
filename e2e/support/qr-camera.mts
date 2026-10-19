import type { Page } from '@playwright/test';

interface CameraWindow {
  __trinitySetQrCameraImage(url: string): Promise<void>;
}

/**
 * Give `page` a camera that films a still image: the app's production scanner then reads a
 * QR code from it without camera hardware. Call before the page loads, then
 * {@link showOnCamera}; the camera opens only once it has an image.
 */
export async function installSyntheticCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let stream: MediaStream | undefined;
    let resolveImage: () => void = () => undefined;
    const imageReady = new Promise<void>((resolve) => {
      resolveImage = resolve;
    });

    (window as unknown as CameraWindow).__trinitySetQrCameraImage = async (
      url,
    ) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      stream = canvas.captureStream(5);
      resolveImage();
    };

    const mediaDevices = navigator.mediaDevices ?? {};
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...mediaDevices,
        getUserMedia: async () => {
          await imageReady;
          return stream;
        },
      },
    });
  });
}

/** Point the synthetic camera at an image, such as a QR code's data URL. */
export async function showOnCamera(page: Page, url: string): Promise<void> {
  await page.evaluate(
    (src) => (window as unknown as CameraWindow).__trinitySetQrCameraImage(src),
    url,
  );
}
