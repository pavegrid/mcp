import { main } from '../src/main.js';
import { fixtureFetch, token } from './fixtures.js';
// Subprocess fixture: fake token and API only; no OS credential access.
await main(['serve'], { store: { read: async () => token, write: async () => {}, remove: async () => {} }, fetcher: fixtureFetch() });
