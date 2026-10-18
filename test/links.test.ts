import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkFindMatches, linkRows, linkSummary } from '../src/links.js';
import { org, site, project, contract, event } from './fixtures.js';

const otherSite = '66666666-6666-4666-8666-666666666666';
for (const origin of ['https://www.pavegrid.io', 'https://pavegrid.com']) {
  test(`record links on ${origin}`, () => {
    const [coded, plain] = linkRows('site', origin, [{ id: site, link_code: 'k7m2x9' }, { id: otherSite }]);
    assert.equal(coded.url, `${origin}/map?site=k7m2x9`); assert.equal(plain.url, `${origin}/map?site=${otherSite}`);
    assert.equal(linkRows('project', origin, [{ id: project, site_id: site }])[0].url, `${origin}/map?site=${site}&project=${project}`);
    const input = { id: contract, org_id: org, site_id: site, wo_number: 'BI-101' };
    assert.deepEqual(linkRows('contract_item', origin, [input])[0], { ...input, url: `${origin}/contract-items/${contract}`, upload_url: `${origin}/import-center/new?site=${site}` });
    const [withItem, draft] = linkRows('event', origin, [{ id: event, site_id: site, work_order_id: contract }, { id: event, site_id: site, work_order_id: null }]);
    assert.equal(withItem.url, `${origin}/map?site=${site}&job=${contract}&focus=1&activity=${event}`); assert.equal(draft.url, `${origin}/map?site=${site}&event=${event}`);
    for (const row of [...linkRows('project', origin, [{ id: project }]), ...linkRows('contract_item', origin, [{ wo_number: 'BI-101' }]), ...linkRows('event', origin, [{ id: event }])]) {
      assert.ok(!('url' in row) && !('upload_url' in row));
    }
  });
  test(`find matches and summary groups link by kind on ${origin}`, () => {
    const matches = linkFindMatches(origin, [
      { type: 'site', id: site, org_id: org, name: 'North Yard' },
      { type: 'project', id: project, org_id: org, name: 'Phase 1', site_id: site },
      { type: 'contract_item', id: contract, org_id: org, site_id: site, wo_number: 'BI-101' },
    ]);
    assert.deepEqual(matches.map(match => match.url), [`${origin}/map?site=${site}`, `${origin}/map?site=${site}&project=${project}`, `${origin}/contract-items/${contract}`]);
    assert.deepEqual(matches.map(match => match.upload_url), [undefined, undefined, `${origin}/import-center/new?site=${site}`]);
    const group = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: key, counts: {}, totals: {}, ...extra });
    const urls = (groupBy: string, scope: Record<string, unknown>, groups: Record<string, unknown>[]) => (linkSummary(origin, { scope: { group_by: groupBy, ...scope }, groups, totals: {} }).groups as { url: string }[]).map(g => g.url);
    assert.deepEqual(urls('site', { site_id: null }, [group(site)]), [`${origin}/map?site=${site}`]);
    assert.deepEqual(urls('project', { site_id: null }, [group(project, { site_id: site }), group(`unassigned:${otherSite}`, { site_id: otherSite })]), [`${origin}/map?site=${site}&project=${project}`, `${origin}/map?site=${otherSite}`]);
    assert.deepEqual(urls('contract_item', { site_id: site }, [group(contract), group('unassigned')]), [`${origin}/contract-items/${contract}`, `${origin}/map?site=${site}`]);
    assert.deepEqual(urls('status', { site_id: site, project_id: project }, [group('open')]), [`${origin}/map?site=${site}&project=${project}`]);
    assert.deepEqual(urls('type', { site_id: null, project_id: null }, [group('bid_item')]), [`${origin}/map`]);
  });
}
test('largest Event links take the Site from the scope when the Event has none; empty highlights stay alone', () => {
  const largest = { id: event, work_order_id: contract, area_sq_ft: 5 };
  const result = linkSummary('https://pavegrid.com/', {
    scope: { site_id: site, group_by: 'status' }, totals: {}, highlights: { largest_event: largest },
    groups: [{ key: 'open', label: 'open', highlights: { largest_event: { ...largest, site_id: otherSite } } }, { key: 'done', label: 'done', highlights: { largest_event: null } }],
  }) as unknown as { highlights: { largest_event: { url: string } }; groups: { highlights: { largest_event: { url: string } | null } }[] };
  assert.equal(result.highlights.largest_event.url, `https://pavegrid.com/map?site=${site}&job=${contract}&focus=1&activity=${event}`);
  assert.equal(result.groups[0].highlights.largest_event?.url, `https://pavegrid.com/map?site=${otherSite}&job=${contract}&focus=1&activity=${event}`);
  assert.equal(result.groups[1].highlights.largest_event, null);
  assert.ok(!('highlights' in linkSummary('https://pavegrid.com', { scope: {}, groups: [], totals: {} })));
});
