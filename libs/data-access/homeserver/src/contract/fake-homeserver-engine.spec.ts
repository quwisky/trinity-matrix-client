import { defineHomeserverEngineContract } from './homeserver-engine.contract';
import { FakeHomeserverEngine } from './fake-homeserver-engine';

defineHomeserverEngineContract(async () => {
  const engine = new FakeHomeserverEngine();
  engine.set('@me:example.org', {
    serverName: 'example.org',
    baseUrl: 'https://matrix.example.org',
    software: null,
    specVersions: ['v1.11'],
    unstableFeatures: [],
    capabilities: null,
  });
  return { engine, accountId: '@me:example.org', serverName: 'example.org' };
});
