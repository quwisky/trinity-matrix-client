import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createClient } from 'matrix-js-sdk';
import { logger as sdkRootLogger } from 'matrix-js-sdk/lib/logger';
import loglevel from 'loglevel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATRIX_SDK_LOG_SINK,
  configureMatrixSdkLogging,
  matrixSdkLogLevel,
  provideMatrixSdkLogging,
  setMatrixSdkDetailedLogging,
  type MatrixSdkLogRecord,
  type MatrixSdkLogSink,
} from './matrix-sdk-logging';

describe('configureMatrixSdkLogging', () => {
  it('shares matrix-js-sdk’s copy of loglevel', () => {
    // The SDK's loggers live in its loglevel registry. If a dependency bump ever splits
    // Trinity's `loglevel` from the SDK's, configuring silently does nothing and production
    // prints the SDK's debug output again (#1208): keep the two versions in step.
    const fromTrinity = createRequire(import.meta.url);
    const sdkPackage = realpathSync(
      fromTrinity.resolve('matrix-js-sdk/package.json'),
    );
    const fromSdk = createRequire(sdkPackage);
    expect(
      realpathSync(fromTrinity.resolve('loglevel')),
      'loglevel diverged from matrix-js-sdk’s copy; align their versions',
    ).toBe(realpathSync(fromSdk.resolve('loglevel')));
  });

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
    setMatrixSdkDetailedLogging(false);
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

  it('leaves the console level alone when detailed logging is turned on without a sink', () => {
    configureMatrixSdkLogging('warn');

    setMatrixSdkDetailedLogging(true);
    sdkRootLogger.debug('debug line');

    expect((sdkRootLogger as unknown as loglevel.Logger).getLevel()).toBe(
      loglevel.levels.WARN,
    );
    expect(debug).not.toHaveBeenCalled();
  });

  describe('with a diagnostic sink', () => {
    function recordingSink(): MatrixSdkLogSink & {
      readonly records: MatrixSdkLogRecord[];
    } {
      const records: MatrixSdkLogRecord[] = [];
      return { records, write: (record) => records.push(record) };
    }

    function levelOf(logger: unknown): number {
      return (logger as loglevel.Logger).getLevel();
    }

    it('receives SDK info lines, not debug ones, while the console stays at warn', () => {
      const sink = recordingSink();
      configureMatrixSdkLogging('warn', sink);

      sdkRootLogger.debug('debug line');
      sdkRootLogger.info('info line');
      sdkRootLogger.warn('warn line');

      expect(levelOf(sdkRootLogger)).toBe(loglevel.levels.INFO);
      expect(debug).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('warn line');
      expect(sink.records).toEqual([
        { method: 'info', logger: 'matrix', args: ['info line'] },
        { method: 'warn', logger: 'matrix', args: ['warn line'] },
      ]);
    });

    it('receives debug lines while detailed logging is on, switching live both ways', () => {
      const sink = recordingSink();
      configureMatrixSdkLogging('warn', sink);
      const early = sdkRootLogger.getChild('[detailed-early]');

      setMatrixSdkDetailedLogging(true);
      const late = sdkRootLogger.getChild('[detailed-late]');
      early.debug('early on');
      late.debug('late on');

      expect(levelOf(sdkRootLogger)).toBe(loglevel.levels.DEBUG);
      expect(levelOf(early)).toBe(loglevel.levels.DEBUG);
      expect(levelOf(late)).toBe(loglevel.levels.DEBUG);

      setMatrixSdkDetailedLogging(false);
      early.debug('early off');
      late.debug('late off');

      expect(levelOf(early)).toBe(loglevel.levels.INFO);
      expect(levelOf(late)).toBe(loglevel.levels.INFO);
      expect(sink.records.map((record) => record.args)).toEqual([
        ['early on'],
        ['late on'],
      ]);
      expect(debug).not.toHaveBeenCalled();
    });

    it('keeps debug console output for development builds without recording it', () => {
      const sink = recordingSink();
      configureMatrixSdkLogging('debug', sink);

      sdkRootLogger.debug('debug line');

      expect(debug).toHaveBeenCalledWith('debug line');
      expect(sink.records).toEqual([]);
    });

    it('receives each line from a grandchild exactly once, under its logger name', () => {
      const sink = recordingSink();
      configureMatrixSdkLogging('warn', sink);

      const grandchild = sdkRootLogger
        .getChild('[sink-late]')
        .getChild('[grandchild]');
      grandchild.info('grandchild info');

      expect(sink.records).toEqual([
        {
          method: 'info',
          logger: 'matrix-[sink-late][grandchild]',
          args: ['grandchild info'],
        },
      ]);
      expect(info).not.toHaveBeenCalled();
    });

    it('keeps the SDK logging when the sink throws', () => {
      configureMatrixSdkLogging('warn', {
        write: () => {
          throw new Error('sink failed');
        },
      });

      expect(() => sdkRootLogger.warn('still printed')).not.toThrow();
      expect(warn).toHaveBeenCalledWith('still printed');
    });

    it('prints the console echo through the sink', () => {
      const echoed: string[] = [];
      configureMatrixSdkLogging('warn', {
        write: () => undefined,
        echo: (print) => {
          echoed.push('before');
          print();
          echoed.push('after');
        },
      });

      sdkRootLogger.error('error line');

      expect(echoed).toEqual(['before', 'after']);
      expect(error).toHaveBeenCalledWith('error line');
    });

    it('stops receiving lines once configuration drops it', () => {
      const sink = recordingSink();
      configureMatrixSdkLogging('warn', sink);

      configureMatrixSdkLogging('warn');
      sdkRootLogger.info('after removal');

      expect(sink.records).toEqual([]);
      expect(info).not.toHaveBeenCalled();
    });

    it('falls back to the console level when the sink is detached, and receives again once reattached', () => {
      // "Keep a diagnostic log" off: no SDK logger may stay below the console level.
      const sink = recordingSink();
      configureMatrixSdkLogging('warn', sink);
      const child = sdkRootLogger.getChild(
        '[sink-detach]',
      ) as unknown as loglevel.Logger;
      expect(child.getLevel()).toBe(loglevel.levels.INFO);

      configureMatrixSdkLogging(matrixSdkLogLevel(), null);
      sdkRootLogger.info('while detached');

      expect(child.getLevel()).toBe(loglevel.levels.WARN);
      expect((sdkRootLogger as unknown as loglevel.Logger).getLevel()).toBe(
        loglevel.levels.WARN,
      );
      expect(sink.records).toEqual([]);

      configureMatrixSdkLogging(matrixSdkLogLevel(), sink);
      sdkRootLogger.info('reattached');

      expect(sink.records.map((record) => record.args)).toEqual([
        ['reattached'],
      ]);
      expect(info).not.toHaveBeenCalled();
    });

    it('takes the sink from MATRIX_SDK_LOG_SINK when the root injector is created', () => {
      const sink = recordingSink();
      TestBed.configureTestingModule({
        providers: [
          provideMatrixSdkLogging('warn'),
          { provide: MATRIX_SDK_LOG_SINK, useValue: sink },
        ],
      });
      TestBed.inject(EnvironmentInjector);

      sdkRootLogger.info('via provider');

      expect(sink.records.map((record) => record.args)).toEqual([
        ['via provider'],
      ]);
      expect(info).not.toHaveBeenCalled();
    });
  });
});
