import { type Observable, firstValueFrom, toArray } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertPlainData } from '@trinity/util/matrix';
import type { ContactAddressesEngine } from '../lib/contact-addresses-engine';

/** An identity-server validation session and the access token it was opened with. */
export interface IdentitySession {
  readonly sid: string;
  readonly clientSecret: string;
  readonly idAccessToken: string;
}

export interface ContactAddressesContractSetup {
  engine: ContactAddressesEngine;
  /** A fresh account: no identity-server setting or accepted terms yet. */
  accountId: string;
  /** An email address the account has on its homeserver. */
  address: string;
  serverName: string;
  /**
   * The identity server the engine reports from the client well-known. Null on Synapse:
   * js-sdk reads the well-known only while polling it, which Trinity does not configure.
   */
  wellKnownIdentityServer: string | null;
  /** Present when the contract runs with an identity server. */
  identity?: {
    /** Host and port, as bind and unbind take it. */
    readonly idServer: string;
    /** Host and port of another server, which holds no binding for `address` or is unreachable. */
    readonly otherIdServer: string;
    /** A session for `address` whose emailed link was opened. */
    validatedSession(): Promise<IdentitySession>;
    /** A session for `address` whose link was never opened. */
    unvalidatedSession(): Promise<IdentitySession>;
    /** The Matrix ID the identity server maps `address` to. */
    lookup(address: string): Promise<string | null>;
  };
}

const NOBODY = '@nobody:invalid';

export function defineContactAddressesEngineContract(
  setup: () => Promise<ContactAddressesContractSetup>,
  options: { readonly identity: boolean },
): void {
  describe('ContactAddressesEngine contract', () => {
    let context: ContactAddressesContractSetup;
    beforeAll(async () => {
      context = await setup();
    }, 120_000);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    it('lists the account’s addresses and whether it may change them', async () => {
      expect(await once(context.engine.threePids(context.accountId))).toEqual({
        ok: true,
        value: {
          addresses: [{ medium: 'email', address: context.address }],
          canChange: true,
        },
      });
    });

    it('reads back the identity server it writes, null included, and the well-known one', async () => {
      const { engine, accountId } = context;
      const url = 'https://identity.example.org';

      expect(await once(engine.identityServerSetting(accountId))).toEqual({
        ok: true,
        value: { account: null, wellKnown: context.wellKnownIdentityServer },
      });
      expect(await once(engine.setIdentityServer(accountId, url))).toEqual({
        ok: true,
        value: null,
      });
      expect(await once(engine.identityServerSetting(accountId))).toMatchObject(
        { ok: true, value: { account: { baseUrl: url } } },
      );
      await once(engine.setIdentityServer(accountId, null));
      expect(await once(engine.identityServerSetting(accountId))).toMatchObject(
        { ok: true, value: { account: { baseUrl: null } } },
      );
    });

    it('reads back the accepted terms it writes', async () => {
      const { engine, accountId } = context;
      const urls = ['https://identity.example.org/a', 'https://x.org/b'];

      expect(await once(engine.acceptedTerms(accountId))).toEqual({
        ok: true,
        value: [],
      });
      await once(engine.setAcceptedTerms(accountId, urls));
      expect(await once(engine.acceptedTerms(accountId))).toEqual({
        ok: true,
        value: urls,
      });
    });

    it('issues an OpenID token naming the account’s server', async () => {
      const result = await once(context.engine.openIdToken(context.accountId));

      expect(result).toMatchObject({
        ok: true,
        value: { tokenType: 'Bearer', matrixServerName: context.serverName },
      });
      if (!result.ok) return;
      expect(result.value.accessToken).not.toBe('');
      expect(result.value.expiresIn).toBeGreaterThan(0);
    });

    it('fails every member with account-not-live without a client', async () => {
      const { engine } = context;
      const session = { sid: 's', clientSecret: 'c', idAccessToken: 't' };
      const commands: Observable<unknown>[] = [
        engine.threePids(NOBODY),
        engine.identityServerSetting(NOBODY),
        engine.setIdentityServer(NOBODY, null),
        engine.acceptedTerms(NOBODY),
        engine.setAcceptedTerms(NOBODY, []),
        engine.openIdToken(NOBODY),
        engine.bindThreePid(NOBODY, { ...session, idServer: 'is.invalid' }),
        engine.unbindThreePid(NOBODY, {
          medium: 'email',
          address: 'a@x.invalid',
          idServer: 'is.invalid',
        }),
      ];
      for (const command of commands) {
        expect(await once(command)).toMatchObject({
          ok: false,
          failure: { code: 'account-not-live' },
        });
      }
    });

    describe.skipIf(!options.identity)('with an identity server', () => {
      it('refuses a bind before the emailed link is opened', async () => {
        const identity = context.identity!;
        const session = await identity.unvalidatedSession();

        expect(
          await once(
            context.engine.bindThreePid(context.accountId, {
              ...session,
              idServer: identity.idServer,
            }),
          ),
        ).toMatchObject({
          ok: false,
          failure: {
            code: 'request-failed',
            diagnostic: { errcode: 'M_SESSION_NOT_VALIDATED' },
          },
        });
      });

      it('binds a validated address at the given server and unbinds it only there', async () => {
        const { engine, accountId, address } = context;
        const identity = context.identity!;
        const session = await identity.validatedSession();

        expect(
          await once(
            engine.bindThreePid(accountId, {
              ...session,
              idServer: identity.idServer,
            }),
          ),
        ).toEqual({ ok: true, value: null });
        expect(await identity.lookup(address)).toBe(accountId);

        // The other server may answer that it cannot unbind, or not answer at all.
        const elsewhere = await once(
          engine.unbindThreePid(accountId, {
            medium: 'email',
            address,
            idServer: identity.otherIdServer,
          }),
        );
        expect(
          elsewhere.ok ? elsewhere.value : elsewhere.failure.code,
        ).toBeOneOf(['no-support', 'request-failed']);
        expect(await identity.lookup(address)).toBe(accountId);

        expect(
          await once(
            engine.unbindThreePid(accountId, {
              medium: 'email',
              address,
              idServer: identity.idServer,
            }),
          ),
        ).toEqual({ ok: true, value: 'success' });
        expect(await identity.lookup(address)).toBeNull();
      });
    });
  });
}
