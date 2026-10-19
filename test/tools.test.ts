import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { Api } from '../src/api.js';
import { callTool, createServer, pageResult, toolCatalog } from '../src/tools.js';
import { fixtureFetch, json, identity, summary, org, site, project, contract, event, token } from './fixtures.js';

const inputs: Record<string, Record<string, unknown>> = {
  whoami: {}, list_sites: {}, get_site: { id: site }, list_projects: { site_id: site }, get_project: { id: project },
  list_contract_items: { site_id: site }, get_contract_item: { id: contract }, list_events: { site_id: site }, get_event: { id: event }, get_summary: { site_id: site, group_by: 'project' }, find: { query: '26-410' },
  search: { query: '26-410' }, fetch: { id: `contract_item:${contract}` },
};
test('real SDK discovery/calls validate annotations, output schema and text fallback for all tools', async () => {
  const server = createServer(new Api(token, { fetcher: fixtureFetch() }));
  const client = new Client({ name: 'test-host', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools(); assert.equal(tools.length, 13);
    for (const tool of tools) {
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      assert.equal(tool.outputSchema?.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false);
      const result = await client.callTool({ name: tool.name, arguments: inputs[tool.name] });
      assert.ok(!result.isError, tool.name); assert.ok(result.structuredContent);
      const first = result.content[0]; assert.equal(first.type, 'text');
      if (first.type === 'text') assert.deepEqual(JSON.parse(first.text), result.structuredContent);
      assert.equal((result.structuredContent as Record<string, unknown>).untrusted_content, true);
    }
    const rejected = await client.callTool({ name: 'list_events', arguments: { site_id: site, limit: 51, [token]: token } });
    assert.equal(rejected.isError, true); assert.ok(!JSON.stringify(rejected).includes(token));
    const unknown = await client.callTool({ name: `write_${token}`, arguments: {} });
    assert.equal(unknown.isError, true); assert.ok(!JSON.stringify(unknown).includes(token));
  } finally { await client.close(); await server.close(); }
});
test('completeness distinguishes one page, final partial page and full response', () => {
  const data = [{ id: contract }];
  assert.deepEqual(pageResult({ data, total: 2, limit: 1, offset: 0 }, { limit: 1, offset: 0 }).next_offset, 1);
  const last = pageResult({ data, total: 2, limit: 1, offset: 1 }, { limit: 1, offset: 1 });
  assert.equal(last.complete, false); assert.equal(last.next_offset, null);
  const full = pageResult({ data, total: 1, limit: 1, offset: 0 }, { limit: 1, offset: 0 });
  assert.equal(full.complete, true); assert.equal(full.returned, 1);
  assert.throws(() => pageResult({ data: [], total: 1, limit: 25, offset: 0 }));
});
test('list rows are compact: no outline, bookkeeping or empty values; cost fields stay even when empty; get_event keeps all', async () => {
  const outline = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1.5, 0], [1.5, 2.5], [0, 0]]] } };
  const row = { id: event, org_id: org, site_id: site, manual_sf: 1200, geometry_px: outline, updated_by: 'u', seq: 4, notes: null, tags: [], total_cost: null };
  const api = new Api(token, { fetcher: async (url, init) => url.pathname === '/api/activities' ? json({ data: [row], total: 1, limit: 25, offset: 0 })
    : url.pathname === `/api/activities/${event}` ? json(row) : fixtureFetch()(url, init) });
  const tools = toolCatalog(api);
  const list = await callTool(tools.find(t => t.name === 'list_events')!, { site_id: site });
  assert.deepEqual((list.structuredContent as { data: unknown[] }).data, [{ id: event, org_id: org, site_id: site, manual_sf: 1200, total_cost: null, url: `https://pavegrid.com/map?site=${site}&event=${event}` }]);
  const detail = await callTool(tools.find(t => t.name === 'get_event')!, { id: event });
  assert.deepEqual((detail.structuredContent as { data: Record<string, unknown> }).data.geometry_px, outline);
});
test('summary preserves units, hidden costs and server-defined fields and validates filters', async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const tool = toolCatalog(new Api(token, { fetcher: fixtureFetch(calls) })).find(t => t.name === 'get_summary')!;
  const result = await callTool(tool, { site_id: site, project_id: project, group_by: 'project', from: '2026-01-01', to: '2026-10-10' });
  const value = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(value?.totals, summary.totals); assert.deepEqual(value?.units, summary.units); assert.equal(value?.cost_visible, false);
  assert.deepEqual(value?.highlights, { ...summary.highlights, largest_event: { ...summary.highlights.largest_event, url: `https://pavegrid.com/map?site=${site}&job=${contract}&focus=1&activity=${event}` } }); assert.match(tool.description ?? '', /highlights/);
  const url = calls.at(-1)!.url; assert.equal(url.pathname, '/api/ai-access/summary'); assert.equal(url.searchParams.get('project_id'), project); assert.equal(url.searchParams.get('from'), '2026-01-01');
  for (const invalid of [{ group_by: 'bad' }, { from: '2026-02-30' }, { from: '2026-10-10', to: '2026-01-01' }]) assert.equal((await callTool(tool, { site_id: site, group_by: 'status', ...invalid })).isError, true);
});
test('summary without site_id covers the whole company; group_by site needs that scope; project_id needs site_id', async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const tool = toolCatalog(new Api(token, { fetcher: fixtureFetch(calls) })).find(t => t.name === 'get_summary')!;
  const result = await callTool(tool, { group_by: 'site', from: '2026-01-01' });
  assert.ok(!result.isError);
  const url = calls.at(-1)!.url; assert.equal(url.pathname, '/api/ai-access/summary'); assert.equal(url.searchParams.get('site_id'), null); assert.equal(url.searchParams.get('group_by'), 'site');
  assert.deepEqual((result.structuredContent as { groups: { highlights?: unknown }[] }).groups[0].highlights, summary.groups[0].highlights); assert.match(tool.description ?? '', /each with that Site's highlights/);
  for (const invalid of [{ site_id: site, group_by: 'site' }, { project_id: project, group_by: 'project' }]) assert.equal((await callTool(tool, invalid)).isError, true);
});
test('summary group_by contract_item needs site_id and passes it through', async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const tool = toolCatalog(new Api(token, { fetcher: fixtureFetch(calls) })).find(t => t.name === 'get_summary')!;
  assert.ok(!(await callTool(tool, { site_id: site, group_by: 'contract_item' })).isError);
  const url = calls.at(-1)!.url; assert.equal(url.searchParams.get('site_id'), site); assert.equal(url.searchParams.get('group_by'), 'contract_item');
  assert.match(tool.description ?? '', /rank Contract Items by Events/);
  assert.equal((await callTool(tool, { group_by: 'contract_item' })).isError, true);
});
test('find searches the whole company by name or number and keeps the org check', async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const tool = toolCatalog(new Api(token, { fetcher: fixtureFetch(calls) })).find(t => t.name === 'find')!;
  const result = await callTool(tool, { query: ' 26-410 ' });
  assert.ok(!result.isError);
  const url = calls.at(-1)!.url; assert.equal(url.pathname, '/api/ai-access/find'); assert.equal(url.searchParams.get('query'), '26-410');
  assert.equal((result.structuredContent as { data: { wo_number: string }[] }).data[0].wo_number, '26-410');
  const narrowed = await callTool(tool, { query: 'TO-108', site_id: site });
  assert.ok(!narrowed.isError);
  const narrowedUrl = calls.at(-1)!.url; assert.equal(narrowedUrl.searchParams.get('query'), 'TO-108'); assert.equal(narrowedUrl.searchParams.get('site_id'), site);
  for (const invalid of [{}, { query: '' }, { query: 'x'.repeat(101) }, { query: 'a', site_id: 'not-a-uuid' }, { query: 'a', project_id: site }]) assert.equal((await callTool(tool, invalid)).isError, true);
});
test('tools that show or total stages say what the default stage order and the three stage groups mean', () => {
  const tools = toolCatalog(new Api(token, { fetcher: fixtureFetch() }));
  for (const name of ['list_contract_items', 'get_contract_item', 'find', 'get_summary']) {
    const { description } = tools.find(t => t.name === name)!;
    assert.match(description, /initiation, prewalk, planning, paving_day, post_paving, closed/, name);
    assert.match(description, /not started = initiation, prewalk and planning; in progress = paving_day and post_paving; done = closed/, name);
  }
  for (const name of ['get_summary', 'find', 'list_events']) {
    const { description } = tools.find(t => t.name === name)!;
    assert.match(description, /placement temperature, inspector sign-off or crew hours: answer "not recorded" at once/, name);
  }
  for (const name of ['find', 'search']) {
    assert.match(tools.find(t => t.name === name)!.description, /complete is true and there are no matches, you can see no such record: ask the user and do not search other records/, name);
  }
  const { description } = tools.find(t => t.name === 'get_summary')!;
  for (const field of ['highlights.first_date', 'highlights.last_date', 'highlights.contract_items_without_events', 'highlights.largest_event', 'highlights.over_budget']) assert.ok(description.includes(field), field);
  assert.match(description, /For "Which was the largest Event\?" read highlights.largest_event; do not page list_events/);
  assert.match(description, /last_date is the latest Contract Item date, not an Event date/);
});
test('get_summary types highlights at the top level and on each group; a highlight missing a typed field is refused', async () => {
  const tool = toolCatalog(new Api(token, { fetcher: fixtureFetch() })).find(t => t.name === 'get_summary')!;
  type Level = { properties: Record<string, { anyOf?: { properties?: Record<string, unknown> }[] }>; required: string[] };
  const schema = z.toJSONSchema(tool.output, { target: 'draft-7' }) as unknown as { properties: { highlights: Level; groups: { items: { properties: { highlights: Level } } } } };
  for (const level of [schema.properties.highlights, schema.properties.groups.items.properties.highlights]) {
    assert.deepEqual(Object.keys(level.properties).sort(), ['contract_items_without_events', 'first_date', 'largest_event', 'last_date', 'over_budget']);
    assert.deepEqual(level.required, ['first_date', 'last_date', 'contract_items_without_events', 'largest_event']);
    const largest = level.properties.largest_event.anyOf?.find(branch => branch.properties)?.properties ?? {};
    for (const key of ['id', 'wo_number', 'location_label', 'area_sq_ft', 'date', 'url']) assert.ok(key in largest, key);
  }
  const overBudget = { ...summary.highlights, over_budget: { contract_items: 2, amount: 1250.5 } };
  const kept = await callTool(toolCatalog(new Api(token, { fetcher: async (url, init) => url.pathname.endsWith('/summary') ? json({ ...summary, highlights: overBudget }) : fixtureFetch()(url, init) })).find(t => t.name === 'get_summary')!, { site_id: site, group_by: 'status' });
  assert.deepEqual((kept.structuredContent as { highlights: { over_budget: unknown } }).highlights.over_budget, overBudget.over_budget);
  const partial = Object.fromEntries(Object.entries(summary.highlights).filter(([key]) => key !== 'contract_items_without_events'));
  const refused = await callTool(toolCatalog(new Api(token, { fetcher: async (url, init) => url.pathname.endsWith('/summary') ? json({ ...summary, highlights: partial }) : fixtureFetch()(url, init) })).find(t => t.name === 'get_summary')!, { site_id: site, group_by: 'status' });
  assert.deepEqual(refused, { isError: true, content: [{ type: 'text', text: 'PaveGrid returned an unexpected record response.' }] });
  const bare = Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'highlights'));
  const plain = await callTool(toolCatalog(new Api(token, { fetcher: async (url, init) => url.pathname.endsWith('/summary') ? json({ ...bare, groups: [] }) : fixtureFetch()(url, init) })).find(t => t.name === 'get_summary')!, { site_id: site, group_by: 'status' });
  assert.ok(!plain.isError);
});
test('company summary by site links each group\'s largest Event on that group\'s Site', async () => {
  const other = '88888888-8888-4888-8888-888888888888';
  const largest = { id: event, work_order_id: contract, wo_number: '26-410', location_label: null, area_sq_ft: 9, date: null };
  const highlights = { first_date: null, last_date: null, contract_items_without_events: 0, largest_event: largest };
  const bySite = { ...summary, scope: { org_id: org, site_id: null, group_by: 'site' }, groups: [{ key: other, label: 'Yard', counts: {}, totals: {}, highlights }], highlights: { ...highlights, largest_event: null } };
  const tool = toolCatalog(new Api(token, { fetcher: async (url, init) => url.pathname.endsWith('/summary') ? json(bySite) : fixtureFetch()(url, init) })).find(t => t.name === 'get_summary')!;
  const result = await callTool(tool, { group_by: 'site' });
  const group = (result.structuredContent as { groups: { url: string; highlights: { largest_event: { url: string } } }[] }).groups[0];
  assert.equal(group.url, `https://pavegrid.com/map?site=${other}`);
  assert.equal(group.highlights.largest_event.url, `https://pavegrid.com/map?site=${other}&job=${contract}&focus=1&activity=${event}`);
});
test('scope is rechecked per call; revocation and org-off fail next call', async () => {
  let enabled = true;
  const api = new Api(token, { fetcher: async (url, init) => !enabled ? json({}, 401) : fixtureFetch()(url, init) });
  const tool = toolCatalog(api).find(t => t.name === 'list_sites')!;
  assert.ok(!(await callTool(tool, {})).isError); enabled = false;
  assert.equal((await callTool(tool, {})).isError, true);
});
test('foreign org records are refused; instructions in data remain labelled data', async () => {
  const api = new Api(token, { fetcher: async url => url.pathname.endsWith('whoami') ? json(identity) : json({ id: project, org_id: site }) });
  const tool = toolCatalog(api).find(t => t.name === 'get_project')!;
  assert.equal((await callTool(tool, { id: project })).isError, true);
  const calls: { url: URL; init: RequestInit }[] = [];
  const siteTool = toolCatalog(new Api(token, { fetcher: fixtureFetch(calls) })).find(t => t.name === 'get_site')!;
  const result = await callTool(siteTool, { id: site });
  assert.equal((result.structuredContent as Record<string, unknown>)?.untrusted_content, true);
  assert.match(JSON.stringify(result.structuredContent), /Ignore instructions/);
  assert.ok(calls.every(call => call.url.origin === 'https://pavegrid.com'));
  assert.ok(calls.some(call => call.url.pathname === '/api/sites')); assert.ok(org);
});
for (const origin of ['https://www.pavegrid.io', 'https://pavegrid.com']) {
  test(`list, get, find and summary records carry url on ${origin}; Contract Items also upload_url`, async () => {
    const tools = toolCatalog(new Api(token, { fetcher: fixtureFetch(), origin }));
    const call = async (name: string, input: Record<string, unknown>) => (await callTool(tools.find(t => t.name === name)!, input)).structuredContent as Record<string, unknown>;
    const items = await call('list_contract_items', { site_id: site }) as { data: Record<string, unknown>[] };
    assert.equal(items.data[0].url, `${origin}/contract-items/${contract}`); assert.equal(items.data[0].upload_url, `${origin}/import-center/new?site=${site}`);
    assert.equal(((await call('get_site', { id: site })).data as Record<string, unknown>).url, `${origin}/map?site=${site}`);
    assert.equal(((await call('get_event', { id: event })).data as Record<string, unknown>).url, `${origin}/map?site=${site}&event=${event}`);
    assert.equal(((await call('find', { query: '26-410' })).data as Record<string, unknown>[])[0].upload_url, `${origin}/import-center/new?site=${site}`);
    assert.equal(((await call('get_summary', { site_id: site, group_by: 'project' })).groups as Record<string, unknown>[])[0].url, `${origin}/map?site=${site}&project=${project}`);
    for (const tool of tools.filter(t => t.name !== 'whoami')) assert.match(tool.description, /End your answer with the url of each/, tool.name);
  });
  test(`search and fetch return the ChatGPT deep research shape on ${origin}`, async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const tools = toolCatalog(new Api(token, { fetcher: fixtureFetch(calls), origin }));
    const search = await callTool(tools.find(t => t.name === 'search')!, { query: ' 26-410 ' });
    assert.equal(calls.at(-1)!.url.pathname, '/api/ai-access/find'); assert.equal(calls.at(-1)!.url.search, '?query=26-410');
    assert.deepEqual((search.structuredContent as { results: unknown[] }).results, [{ id: `contract_item:${contract}`, title: '26-410 (Bid Item)', url: `${origin}/contract-items/${contract}`, text: 'Contract Item 26-410, Bid Item, stage planning, in Site Example Site.' }]);
    assert.equal((search.structuredContent as { complete: boolean }).complete, true);
    const fetchTool = tools.find(t => t.name === 'fetch')!;
    const cases: [string, string, string, Record<string, unknown>][] = [
      [`site:${site}`, 'Example Site', `${origin}/map?site=${site}`, { type: 'site', org_id: org, site_id: site }],
      [`project:${project}`, 'Example project', `${origin}/map?site=${site}&project=${project}`, { type: 'project', org_id: org, site_id: site, project_id: project }],
      [`contract_item:${contract}`, 'Contract Item (Bid Item)', `${origin}/contract-items/${contract}`, { type: 'contract_item', org_id: org, site_id: site, upload_url: `${origin}/import-center/new?site=${site}` }],
    ];
    for (const [id, title, url, metadata] of cases) {
      const result = await callTool(fetchTool, { id });
      const body = result.structuredContent as Record<string, unknown>;
      assert.deepEqual({ id: body.id, title: body.title, url: body.url, metadata: body.metadata }, { id, title, url, metadata }, id);
      assert.equal((JSON.parse(String(body.text)) as Record<string, unknown>).url, url); assert.equal(body.untrusted_content, true);
    }
  });
}
test('search and fetch refuse other companies, add no cost and reject malformed ids', async () => {
  const foreign = '77777777-7777-4777-8777-777777777777';
  const records = (find: unknown, record: unknown) => new Api(token, { fetcher: async (url, init) => url.pathname.endsWith('/find') ? json(find) : url.pathname.endsWith(`/${contract}`) ? json(record) : fixtureFetch()(url, init) });
  const [search, fetchTool] = ['search', 'fetch'].map(name => toolCatalog(records({ query: 'yard', complete: true, data: [{ type: 'site', id: foreign, org_id: foreign, name: 'Secret Yard' }] }, { id: contract, org_id: foreign, site_id: site, wo_number: 'Secret-7' })).find(t => t.name === name)!);
  for (const result of [await callTool(search, { query: 'yard' }), await callTool(fetchTool, { id: `contract_item:${contract}` })]) {
    assert.deepEqual(result, { isError: true, content: [{ type: 'text', text: 'This record belongs to another company. Access refused.' }] }); assert.ok(!JSON.stringify(result).includes('Secret'));
  }
  const costless = toolCatalog(records({ query: 'bi', complete: true, data: [{ type: 'contract_item', id: contract, org_id: org, site_id: site, wo_number: 'BI-101', total_cost: 987654.32 }] }, { id: contract, org_id: org, site_id: site, wo_number: 'BI-101' }));
  assert.doesNotMatch(JSON.stringify(await callTool(costless.find(t => t.name === 'search')!, { query: 'bi' })), /total_cost|987654/);
  assert.doesNotMatch(JSON.stringify(await callTool(costless.find(t => t.name === 'fetch')!, { id: `contract_item:${contract}` })), /total_cost|budget|variance|vendor/);
  for (const id of [contract, `event:${event}`, `repair:${contract}`, `site:not-a-uuid`, `site:${site}/x`]) assert.equal((await callTool(fetchTool, { id })).isError, true, id);
  assert.equal((await callTool(search, { query: 'a', site_id: site })).isError, true);
});
