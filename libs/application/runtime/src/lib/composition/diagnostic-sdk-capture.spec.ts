import { TestBed } from '@angular/core/testing';
import {
  MATRIX_SDK_LOG_SINK,
  configureMatrixSdkLogging,
  matrixSdkLogLevel,
  type MatrixSdkLogSink,
} from '@trinity/data-access/matrix-client';
import { describe, expect, it, vi } from 'vitest';
import { matrixSdkCapture } from './diagnostic-sdk-capture';

vi.mock('@trinity/data-access/matrix-client', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@trinity/data-access/matrix-client')
  >()),
  configureMatrixSdkLogging: vi.fn(),
}));

describe('matrixSdkCapture', () => {
  it('detaches the SDK sink when disabled and attaches it again when enabled', () => {
    const sink: MatrixSdkLogSink = { write: vi.fn() };
    TestBed.configureTestingModule({
      providers: [{ provide: MATRIX_SDK_LOG_SINK, useValue: sink }],
    });
    const capture = TestBed.runInInjectionContext(matrixSdkCapture);

    capture.setEnabled(false);
    expect(configureMatrixSdkLogging).toHaveBeenLastCalledWith(
      matrixSdkLogLevel(),
      null,
    );

    capture.setEnabled(true);
    expect(configureMatrixSdkLogging).toHaveBeenLastCalledWith(
      matrixSdkLogLevel(),
      sink,
    );
  });
});
