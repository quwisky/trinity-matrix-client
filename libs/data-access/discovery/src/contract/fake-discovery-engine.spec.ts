import { defineDiscoveryEngineContract } from './discovery-engine.contract';
import { FakeDiscoveryEngine } from './fake-discovery-engine';

defineDiscoveryEngineContract(async () => {
  const engine = new FakeDiscoveryEngine();
  engine.accounts.add('@me:example.org');
  engine.servers.set('example.org', 'https://matrix.example.org');
  engine.rooms.push({
    roomId: '!lobby:example.org',
    name: 'Lobby',
    topic: null,
    alias: '#lobby:example.org',
    avatarMxc: null,
    memberCount: 3,
    isSpace: false,
  });
  engine.users.push({
    userId: '@bob:example.org',
    displayName: 'Bob',
    avatarMxc: null,
  });
  return {
    engine,
    accountId: '@me:example.org',
    domain: 'example.org',
    publicRoom: {
      roomId: '!lobby:example.org',
      name: 'Lobby',
      alias: '#lobby:example.org',
    },
    otherUser: { userId: '@bob:example.org', displayName: 'Bob' },
  };
});
