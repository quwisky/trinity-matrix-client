import { EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createClient } from 'matrix-js-sdk';
import { logger as sdkRootLogger } from 'matrix-js-sdk/lib/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureMatrixSdkLogging,
  matrixSdkLogLevel,
  provideMatrixSdkLogging,
} from './matrix-sdk-logging';

describe('configureMatrixSdkLogging', () => {
  let debug: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // The SDK's loggers are process-wide; leave them at the SDK default for other specs.
    configureMatrixSdkLogging('debug');
    vi.restoreAllMocks();
  });

  it('keeps debug and info output out of the console at warn', () => {
    configureMatrixSdkLogging('warn');

    sdkRootLogger.debug('debug line');
    sdkRootLogger.info('info line');
    sdkRootLogger.warn('warn line');
    sdkRootLogger.error('error line');

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('warn line');
    expect(error).toHaveBeenCalledWith('error line');
  });

  it('lowers child loggers the SDK created before configuration', () => {
    // Stands in for module-level children such as the SDK's RoomStickyEvents logger,
    // which exist as soon as matrix-js-sdk is imported.
    const early = sdkRootLogger.getChild('[early]');

    configureMatrixSdkLogging('warn');
    early.debug('early debug');
    early.info('early info');

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('lowers child loggers the SDK creates after configuration', () => {
    configureMatrixSdkLogging('warn');

    // The SDK sets every new child to DEBUG when it creates it.
    const late = sdkRootLogger.getChild('[late]');
    const grandchild = late.getChild('[grandchild]');
    late.debug('late debug');
    grandchild.info('grandchild info');
    grandchild.warn('grandchild warn');

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[late][grandchild]', 'grandchild warn');
  });

  it('keeps a new client from logging its requests', async () => {
    configureMatrixSdkLogging('warn');
    const client = createClient({
      baseUrl: 'https://matrix.example.test',
      fetchFn: async () =>
        new Response(JSON.stringify({ flows: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
    });

    // Unconfigured, this logs `FetchHttpApi: --> GET <url>` and `<-- GET <url>` at debug.
    await client.loginFlows();

    expect(debug).not.toHaveBeenCalled();
  });

  it('restores debug output for development builds', () => {
    configureMatrixSdkLogging('warn');
    const child = sdkRootLogger.getChild('[restored]');

    configureMatrixSdkLogging('debug');
    sdkRootLogger.debug('root debug');
    child.debug('child debug');

    expect(debug).toHaveBeenCalledWith('root debug');
    expect(debug).toHaveBeenCalledWith('[restored]', 'child debug');
  });

  it('applies the level when the root injector is created', () => {
    TestBed.configureTestingModule({
      providers: [provideMatrixSdkLogging('warn')],
    });
    TestBed.inject(EnvironmentInjector);

    sdkRootLogger.debug('root debug');

    expect(debug).not.toHaveBeenCalled();
    expect(matrixSdkLogLevel()).toBe('warn');
  });
});
