import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountElement } from './account-workspace-client.mts';

const sensitiveSurfaceSelector =
  '[data-testid="recovery-key"], [data-testid="recovery-key-input"], input[type="password"]';

interface SecretSafeCaptureClient {
  readonly output: string;
  elements(
    selector: string,
  ): Promise<
    readonly Pick<AccountElement, 'visible' | 'text' | 'value'>[]
  >;
  surface(): Promise<{ readonly url: string }>;
  record(name: string, value: unknown): Promise<void>;
  capture(name: string): Promise<void>;
}

const describeFailure = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Never capture a raster while plaintext recovery or password material is visible. */
export async function captureSecretSafe(
  client: SecretSafeCaptureClient,
  name: string,
): Promise<void> {
  let sensitiveSurfaces: readonly Pick<
    AccountElement,
    'visible' | 'text' | 'value'
  >[];
  try {
    sensitiveSurfaces = await client.elements(sensitiveSurfaceSelector);
  } catch (error) {
    if (!describeFailure(error).includes('Account WebView is active')) {
      throw error;
    }
    await writeFile(
      join(client.output, `${name}-capture.json`),
      `${JSON.stringify(
        { capture: 'skipped-inactive-client', visibleSensitiveSurface: false },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const visibleSensitiveSurface = sensitiveSurfaces.some(
    (element) =>
      element.visible &&
      (element.text.trim().length > 0 ||
        (element.value?.trim().length ?? 0) > 0),
  );
  if (visibleSensitiveSurface) {
    await client.record(`${name}-capture`, {
      capture: 'suppressed-sensitive-surface',
      pathname: new URL((await client.surface()).url).pathname,
      visibleSensitiveSurface: true,
    });
    return;
  }
  await client.capture(name);
}
