import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { DiagnosticAccount, DiagnosticNameGroup } from './report-facts';
import type { DiagnosticLogStore } from './store/diagnostic-log-store';
import {
  IndexedDbLogStore,
  deleteIndexedDbLog,
} from './store/indexed-db-log-store';

function browserIndexedDb(): IDBFactory | undefined {
  return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

/** Opens the persistent store; a spec swaps in a memory store or a refusal. */
export const DIAGNOSTIC_LOG_STORE_FACTORY = new InjectionToken<
  () => Promise<DiagnosticLogStore>
>('DIAGNOSTIC_LOG_STORE_FACTORY', {
  providedIn: 'root',
  factory: () => () => IndexedDbLogStore.open(browserIndexedDb()),
});

/** Deletes the persistent store when "Keep a diagnostic log" is turned off. */
export const DIAGNOSTIC_LOG_STORE_REMOVER = new InjectionToken<
  () => Promise<void>
>('DIAGNOSTIC_LOG_STORE_REMOVER', {
  providedIn: 'root',
  factory: () => () => deleteIndexedDbLog(browserIndexedDb()),
});

/**
 * Switches matrix-js-sdk's debug capture on and off; implemented by the app, which owns the
 * SDK logging configuration. Called synchronously, first thing, whenever "Keep a diagnostic
 * log" turns off, so no SDK logger stays at debug level for a moment longer.
 */
export interface DiagnosticSdkCapture {
  setEnabled(enabled: boolean): void;
}

export const DIAGNOSTIC_SDK_CAPTURE = new InjectionToken<DiagnosticSdkCapture>(
  'DIAGNOSTIC_SDK_CAPTURE',
);

/**
 * Supplies the signed-in accounts for the export header, and the names the file must not
 * show; implemented by the app, which owns the Matrix clients.
 */
export interface DiagnosticAccountSource {
  /** Active account first. Must complete. */
  accounts(): Observable<readonly DiagnosticAccount[]>;
  /**
   * Room names, room topics and members' display names (the user's own included) of every
   * signed-in account, a group per room. Emits once; iterating the groups throws after the
   * last one if some names could not be read. The export keeps only the names that occur in
   * the log, and nothing stores them.
   */
  knownNames(): Observable<Iterable<DiagnosticNameGroup>>;
}

export const DIAGNOSTIC_ACCOUNT_SOURCE =
  new InjectionToken<DiagnosticAccountSource>('DIAGNOSTIC_ACCOUNT_SOURCE');

/** Where "Open bug report on GitHub" goes; null leaves the GitHub step out. */
export interface DiagnosticReportConfig {
  readonly issueRepositoryUrl: string | null;
}

export const DIAGNOSTIC_REPORT_CONFIG =
  new InjectionToken<DiagnosticReportConfig>('DIAGNOSTIC_REPORT_CONFIG', {
    providedIn: 'root',
    factory: () => ({ issueRepositoryUrl: null }),
  });
