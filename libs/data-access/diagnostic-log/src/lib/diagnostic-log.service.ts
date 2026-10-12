import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BUILD_INFO } from '@trinity/platform-native';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  type PreferenceCommandOutcome,
} from '@trinity/runtime/preferences';
import { defer, from, map, switchMap, type Observable } from 'rxjs';
import { buildLabel } from './build-label';
import { formatLogArgs, truncateMessage } from './capture/format-log-args';
import {
  installConsoleCapture,
  installWindowErrorCapture,
  type ConsoleCaptureLevel,
} from './capture/console-capture';
import type {
  DiagnosticEntry,
  DiagnosticLevel,
  DiagnosticSource,
} from './diagnostic-entry.model';
import { DiagnosticLogRecorder } from './diagnostic-log-recorder';
import {
  DIAGNOSTIC_LOG_STORE_FACTORY,
  DIAGNOSTIC_LOG_STORE_REMOVER,
  DIAGNOSTIC_SDK_CAPTURE,
} from './diagnostic-log.tokens';
import { KEEP_DIAGNOSTIC_LOG_PREFERENCE } from './keep-diagnostic-log.preference';
import { describePlatform, readPlatformFacts } from './platform-description';
import { scrubMessage } from './scrub-secrets';

/** Whether the log survives a reload: not yet known, on disk, or in memory only. */
export type DiagnosticAvailability = 'pending' | 'persistent' | 'memory-only';

/** One line to record; the time is added and the message scrubbed here. */
export interface DiagnosticRecord {
  readonly level: DiagnosticLevel;
  readonly source: DiagnosticSource;
  readonly logger: string;
  readonly message: string;
}

/** A matrix-js-sdk log call, as `MATRIX_SDK_LOG_SINK` delivers it. */
export interface DiagnosticSdkCall {
  readonly method: DiagnosticLevel;
  readonly logger: string;
  readonly args: readonly unknown[];
}

/** Entries held in memory until "Keep a diagnostic log" has been read; the oldest go first. */
export const MAX_EARLY_ENTRIES = 500;

/**
 * "Keep a diagnostic log" was turned off and saved, and recording stopped, but the stored
 * log could be neither deleted nor emptied: it is still on this device.
 */
export class DiagnosticLogNotDeletedError extends Error {
  constructor() {
    super('The diagnostic log could not be deleted.');
  }
}

const noop = (): void => undefined;

/**
 * The on-device diagnostic log. {@link start} runs from `provideDiagnosticLog()` before any
 * Matrix client exists; from then on Trinity's console warnings and errors, uncaught errors,
 * matrix-js-sdk lines (through the SDK sink) and lifecycle markers are scrubbed of secrets
 * and batched into the store, while "Keep a diagnostic log" is on. Consumers never read the
 * store: they export a redacted bundle.
 */
@Injectable({ providedIn: 'root' })
export class DiagnosticLogService {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly build = inject(BUILD_INFO, { optional: true });
  private readonly preferences = inject(PreferenceStoreService);
  private readonly openStore = inject(DIAGNOSTIC_LOG_STORE_FACTORY);
  private readonly sdkCapture = inject(DIAGNOSTIC_SDK_CAPTURE, {
    optional: true,
  });
  private readonly _available = signal<DiagnosticAvailability>('pending');
  private readonly _keepLog = signal(
    KEEP_DIAGNOSTIC_LOG_PREFERENCE.defaultValue,
  );
  private readonly recorder = new DiagnosticLogRecorder({
    openStore: () => this.openStore(),
    removeStore: inject(DIAGNOSTIC_LOG_STORE_REMOVER),
    onStorage: (kind) =>
      this._available.set(kind === 'indexeddb' ? 'persistent' : 'memory-only'),
  });
  /** Entries recorded before the setting is known; null once it is. */
  private early: DiagnosticEntry[] | null = [];
  private started = false;
  private recording = false;
  private consoleCaptureSuspended = 0;

  readonly available = this._available.asReadonly();
  /** Settings › Advanced › Keep a diagnostic log; `true` until the stored value is read. */
  readonly keepLog = this._keepLog.asReadonly();

  /** Install capture and read the setting. Idempotent; undone when the root injector is destroyed. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const view = this.document.defaultView;
    const uninstallConsole = installConsoleCapture(console, (level, args) =>
      this.captureConsole(level, args),
    );
    const uninstallErrors = view
      ? installWindowErrorCapture(view, (kind, message) =>
          this.record({
            level: 'error',
            source: 'window',
            logger: kind,
            message,
          }),
        )
      : noop;
    const onPageHide = (): void => {
      this.marker('app shutting down (page hidden)');
      void this.recorder.flush();
    };
    const onVisibilityChange = (): void => {
      if (this.document.visibilityState === 'hidden') {
        void this.recorder.flush();
      }
    };
    view?.addEventListener('pagehide', onPageHide);
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    this.destroyRef.onDestroy(() => {
      uninstallConsole();
      uninstallErrors();
      view?.removeEventListener('pagehide', onPageHide);
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      void this.recorder.flush();
    });
    this.readSetting();
    this.marker(`app started: ${this.describeBuild()}`);
  }

  /**
   * Scrub and buffer one line, unless "Keep a diagnostic log" is off. Scrubbing comes before
   * the cut to length, so a secret is never kept in part. A console write made while
   * recording is not re-recorded.
   */
  record(record: DiagnosticRecord): void {
    if (this.recording || !this._keepLog()) {
      return;
    }
    this.recording = true;
    try {
      const entry: DiagnosticEntry = {
        ts: Date.now(),
        level: record.level,
        source: record.source,
        logger: truncateMessage(scrubMessage(record.logger)),
        message: truncateMessage(scrubMessage(record.message)),
      };
      if (this.early) {
        this.early.push(entry);
        if (this.early.length > MAX_EARLY_ENTRIES) {
          this.early.shift();
        }
      } else {
        this.recorder.record(entry);
      }
    } finally {
      this.recording = false;
    }
  }

  recordSdk(call: DiagnosticSdkCall): void {
    this.record({
      level: call.method,
      source: 'sdk',
      logger: call.logger,
      message: formatLogArgs(call.args),
    });
  }

  /** Run a console print that is already recorded (the SDK's echo) without capturing it. */
  withoutConsoleCapture(print: () => void): void {
    this.consoleCaptureSuspended += 1;
    try {
      print();
    } finally {
      this.consoleCaptureSuspended -= 1;
    }
  }

  /** Empty the log, buffered entries included. Cold. */
  clear(): Observable<void> {
    return defer(() => from(this.recorder.clear()));
  }

  /**
   * Turn the log on or off for this installation. Off stops recording at once, drops the
   * unflushed batch and deletes the stored log; on starts a fresh log. The change applies to
   * this session as soon as this is subscribed, even if saving the setting then fails; the
   * outcome is the save's. The choice is saved even when the log can't be deleted, and the
   * Observable then errors with {@link DiagnosticLogNotDeletedError}. Cold.
   */
  setKeepLog(keep: boolean): Observable<PreferenceCommandOutcome> {
    return defer(() =>
      from(
        this.applyChoice(keep).then(
          () => null,
          () => new DiagnosticLogNotDeletedError(),
        ),
      ).pipe(
        switchMap((notDeleted) =>
          this.preferences
            .setPreference(
              KEEP_DIAGNOSTIC_LOG_PREFERENCE,
              INSTALLATION_PREFERENCE_CONTEXT,
              keep,
            )
            .pipe(
              map((outcome) => {
                if (notDeleted) {
                  throw notDeleted;
                }
                return outcome;
              }),
            ),
        ),
      ),
    );
  }

  /** Wait for the stored setting before anything reaches the recorder (or is dropped). */
  private readSetting(): void {
    this.preferences
      .hydrateDescriptors(INSTALLATION_PREFERENCE_CONTEXT, [
        KEEP_DIAGNOSTIC_LOG_PREFERENCE,
      ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (this.early === null) {
            return; // the user chose while the read was in flight
          }
          if (outcome.kind !== 'ready') {
            this.offUnconfirmed();
            return;
          }
          const stored = this.preferences.stateFor(
            KEEP_DIAGNOSTIC_LOG_PREFERENCE,
            INSTALLATION_PREFERENCE_CONTEXT,
          )().value;
          // Off already holds for this session; a log that can't be deleted now is
          // deleted at the next start, which reads the same stored "off".
          this.applySetting(stored !== false).catch(() => undefined);
        },
        error: () => this.offUnconfirmed(),
      });
  }

  /** The setting is known: release what was held, or drop it and delete the stored log. */
  private applySetting(keep: boolean): Promise<void> {
    if (!keep) {
      // First, before anything else: no SDK logger may stay at debug level.
      this.sdkCapture?.setEnabled(false);
    }
    const early = this.early ?? [];
    this.early = null;
    this._keepLog.set(keep);
    if (!keep) {
      return this.recorder.discard();
    }
    for (const entry of early) {
      this.recorder.record(entry);
    }
    return Promise.resolve();
  }

  /**
   * The setting could not be read, so an opt-out can't be ruled out: record nothing this
   * session. The stored log is left alone, because deleting it is the user's choice to make.
   */
  private offUnconfirmed(): void {
    this.sdkCapture?.setEnabled(false);
    this.early = null;
    this._keepLog.set(false);
  }

  /** The user's choice from Advanced, which also settles a setting still being read. */
  private applyChoice(keep: boolean): Promise<void> {
    if (this.early !== null) {
      return this.applySetting(keep);
    }
    if (keep === this._keepLog()) {
      return Promise.resolve();
    }
    return keep ? this.resume() : this.stop();
  }

  private stop(): Promise<void> {
    this.sdkCapture?.setEnabled(false);
    this._keepLog.set(false);
    return this.recorder.discard();
  }

  private resume(): Promise<void> {
    this._keepLog.set(true);
    this.sdkCapture?.setEnabled(true);
    this.marker(`diagnostic log turned on: ${this.describeBuild()}`);
    return Promise.resolve();
  }

  private marker(message: string): void {
    this.record({ level: 'info', source: 'app', logger: 'lifecycle', message });
  }

  /** `Trinity v… · … on <platform>`, for the start and turned-on markers. */
  private describeBuild(): string {
    return `${buildLabel(this.build)} on ${describePlatform(readPlatformFacts())}`;
  }

  private captureConsole(
    level: ConsoleCaptureLevel,
    args: readonly unknown[],
  ): void {
    if (this.consoleCaptureSuspended > 0) {
      return;
    }
    this.record({
      level,
      source: 'console',
      logger: 'trinity',
      message: formatLogArgs(args),
    });
  }
}
