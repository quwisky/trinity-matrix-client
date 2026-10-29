import { defineContactAddressesEngineContract } from './contact-addresses-engine.contract';
import { FakeContactAddressesEngine } from './fake-contact-addresses-engine';

const ME = '@me:example.org';
const ADDRESS = 'me@example.org';
const ID_SERVER = 'identity.example.org';
const WELL_KNOWN = 'https://well-known.example.org';

defineContactAddressesEngineContract(
  async () => {
    const engine = new FakeContactAddressesEngine();
    engine.signIn(ME, { threePids: [{ medium: 'email', address: ADDRESS }] });
    engine.wellKnown = WELL_KNOWN;
    let next = 0;
    const session = (validated: boolean) => {
      const sid = `sid-${++next}`;
      engine.sessions.set(sid, {
        clientSecret: `secret-${next}`,
        address: ADDRESS,
        validated,
      });
      return Promise.resolve({
        sid,
        clientSecret: `secret-${next}`,
        idAccessToken: 'is-token',
      });
    };
    return {
      engine,
      accountId: ME,
      address: ADDRESS,
      serverName: 'example.org',
      wellKnownIdentityServer: WELL_KNOWN,
      identity: {
        idServer: ID_SERVER,
        otherIdServer: 'other.example.org',
        validatedSession: () => session(true),
        unvalidatedSession: () => session(false),
        lookup: (address) =>
          Promise.resolve(
            engine.bindings.get(`${ID_SERVER}\n${address}`) ?? null,
          ),
      },
    };
  },
  { identity: true },
);
