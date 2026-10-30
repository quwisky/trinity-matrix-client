import { defineAuthEngineContract } from './auth-engine.contract';
import { FakeAuthEngine } from './fake-auth-engine';

defineAuthEngineContract(
  async () => {
    const engine = new FakeAuthEngine();
    const account = (localpart: string, password: string) => ({
      localpart,
      userId: `@${localpart}:example.org`,
      password,
    });
    const user = account('alice', 'alice-pw');
    const live = account('bob', 'bob-pw');
    const reset = {
      ...account('carol', 'carol-pw'),
      email: 'carol@example.test',
    };
    engine.users.set(user.localpart, { password: user.password });
    engine.users.set(live.localpart, { password: live.password });
    engine.users.set(reset.localpart, {
      password: reset.password,
      email: reset.email,
    });
    engine.accounts.add(live.userId);
    return {
      engine,
      baseUrl: 'https://matrix.example.org',
      user,
      live,
      reset: {
        ...reset,
        confirmLink: async (clientSecret) =>
          engine.confirmResetLink(clientSecret),
      },
      sessionAlive: async (accessToken) => engine.accessTokens.has(accessToken),
      confirmRegistrationLink: async (_email, clientSecret) =>
        engine.confirmRegistrationLink(clientSecret),
    };
  },
  { mail: true },
);
