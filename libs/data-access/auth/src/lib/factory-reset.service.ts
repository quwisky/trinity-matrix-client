import { Injectable, inject } from '@angular/core';
import { Observable, defer, firstValueFrom, from } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  LocalDataWipeService,
  SessionStorageService,
  type WipeReport,
} from '@trinity/platform-native';
import type { OidcSessionBinding } from '@trinity/util/matrix';
import { OidcClientService } from './oidc-client.service';

/**
 * How long the server sign-out gets before the wipe proceeds without it.
 *
 * Deliberately short. The homeserver being unreachable is one of the reasons someone reaches
 * for a factory reset in the first place, so this is a courtesy — it makes the device
 * disappear server-side when the network cooperates — not a precondition.
 */
const SIGN_OUT_BUDGET_MS = 3_000;

/** An OIDC account's provider binding plus the tokens to revoke, read before the wipe. */
interface OidcAccount {
  readonly homeserverUrl: string;
  readonly binding: OidcSessionBinding;
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

/**
 * Erases every trace of Trinity on this device — sessions, keys, settings, cached messages
 * and the service worker — then leaves the caller to restart the app.
 *
 * This is the escape hatch for a wedged install, reachable from the login page because that
 * is where someone lands when they cannot get in. It is irreversible: encryption keys not in
 * a server-side backup go with it, so the caller must confirm intent before calling.
 *
 * **Never errors.** It resolves a {@link WipeReport} instead, because "what survived" is the
 * only useful thing to tell someone whose data was supposed to be gone.
 */
@Injectable({ providedIn: 'root' })
export class FactoryResetService {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly wipe = inject(LocalDataWipeService);
  private readonly oidc = inject(OidcClientService);

  /** Run the reset. Cold — nothing happens until subscription. */
  clearAllData(): Observable<WipeReport> {
    return defer(() => from(this.run()));
  }

  /**
   * The phases, in the one order that works. Written as a sequential async body rather than
   * a pipeline because the ordering constraints between the steps ARE the design, and they
   * are far easier to see — and to get wrong — as operators.
   */
  private async run(): Promise<WipeReport> {
    // A. Read everything first. The registry is the only map from an account to its
    // IndexedDB names and its secure-storage keys, and on Electron the keychain cannot be
    // enumerated at all — once it is gone, whatever it named is unreachable. Tokens too:
    // revoking after the secrets are deleted would have nothing to send.
    const records = await settled(this.storage.list(), []);
    const accounts = await this.readOidcAccounts(records);

    // B. Stop every client. This closes the crypto stores' IndexedDB connections, which is
    // what keeps the deletes in C from blocking.
    await settled(this.matrix.stop(), undefined);

    // C. IndexedDB, before any key/value wipe — see LocalDataWipeService.wipeIndexedDb for
    // why this order is not interchangeable.
    const idb = await this.wipe.wipeIndexedDb(records);

    // C→D gate. A blocked delete means data the user asked to erase is still on disk, and
    // the cause (usually a second tab) is something they can fix. Stop BEFORE signing out or
    // clearing the registry, so a retry starts from a coherent state instead of a
    // half-erased one they can no longer sign in to.
    if (idb.blocked.length > 0) {
      return { ...idb, bulkSecureClear: false };
    }

    // D. Courtesy sign-out, then the point of no return.
    await this.signOutWithinBudget(accounts);
    const bulkSecureClear = await this.wipe.wipeKeyValueStores();
    await this.wipe.wipeServiceWorker();

    return { ...idb, bulkSecureClear };
  }

  /** Load each OIDC account's provider binding and tokens while the registry still exists. */
  private async readOidcAccounts(
    records: readonly { userId: string }[],
  ): Promise<readonly OidcAccount[]> {
    const sessions = await Promise.all(
      records.map((record) => settled(this.storage.load(record.userId), null)),
    );
    return sessions
      .filter((session) => session?.oidc)
      .map((session) => ({
        homeserverUrl: session!.baseUrl,
        binding: session!.oidc!,
        accessToken: session!.accessToken,
        refreshToken: session!.refreshToken,
      }));
  }

  /**
   * Tell the homeserver and any OIDC provider to drop this device, giving up after
   * {@link SIGN_OUT_BUDGET_MS}.
   *
   * A whole-phase budget rather than per-request timeouts: the individual failures are
   * uninteresting (they are all best-effort), and what matters is that the wipe is never
   * held hostage by a server that is down — precisely the situation this feature exists for.
   *
   * The losing side keeps running after the race is decided, which is fine because every
   * branch already swallows its own rejection. That is why `settled()` catches on the way
   * in: an escaping rejection would be reported globally, surfacing an error toast in the
   * middle of a deliberate wipe.
   */
  private async signOutWithinBudget(
    accounts: readonly OidcAccount[],
  ): Promise<void> {
    const attempts = Promise.all([
      settled(this.matrix.signOutAll(), undefined),
      ...accounts.map((account) =>
        settled(
          this.oidc.revokeTokens(account.homeserverUrl, account.binding, {
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
          }),
          undefined,
        ),
      ),
    ]);
    const budget = new Promise<void>((resolve) =>
      setTimeout(resolve, SIGN_OUT_BUDGET_MS),
    );
    await Promise.race([attempts, budget]);
  }
}

/**
 * First value of a cold Observable as a promise that resolves `fallback` instead of
 * rejecting. Every call site here is best-effort, and a rejection escaping into a raced
 * pipeline would land in RxJS's unhandled-error reporter after its subscriber closed.
 */
function settled<T>(source: Observable<T>, fallback: T): Promise<T> {
  return firstValueFrom(source, { defaultValue: fallback }).catch(
    () => fallback,
  );
}
