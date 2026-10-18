/**
 * Absolute app links for tool answers. Every link is built only from ids the
 * row already carries, on the client's own PaveGrid origin, so a link never
 * shows more than the row and never names a host of its own.
 */
type Row = Record<string, unknown>;
export type LinkedKind = 'site' | 'project' | 'contract_item' | 'event';

const text = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null;

const mapHref = (params: Record<string, string>): string => `/map?${new URLSearchParams(params).toString()}`;
const uploadHref = (siteId: string): string => `/import-center/new?${new URLSearchParams({ site: siteId }).toString()}`;

/** The app path for one record, or null when the row lacks an id the link needs. */
function recordPath(kind: LinkedKind, row: Row): string | null {
  const id = text(row.id);
  const siteId = text(row.site_id);
  switch (kind) {
    // Site links prefer the Site's short link code and fall back to its id.
    case 'site': return id ? mapHref({ site: text(row.link_code) ?? id }) : null;
    case 'project': return id && siteId ? mapHref({ site: siteId, project: id }) : null;
    case 'contract_item': return id ? `/contract-items/${encodeURIComponent(id)}` : null;
    case 'event': {
      if (!id || !siteId) return null;
      const workOrderId = text(row.work_order_id);
      return workOrderId ? mapHref({ site: siteId, job: workOrderId, focus: '1', activity: id }) : mapHref({ site: siteId, event: id });
    }
  }
}

const base = (origin: string): string => origin.replace(/\/+$/, '');
const absolute = (origin: string, path: string | null): Row => path ? { url: `${base(origin)}${path}` } : {};
/** Contract Items also link the Imports upload page; no page preselects a Contract Item, so it opens on the Contract Item's Site. */
const upload = (origin: string, row: Row): Row => {
  const siteId = text(row.site_id);
  return siteId ? { upload_url: `${base(origin)}${uploadHref(siteId)}` } : {};
};

/** Rows with `url` (and, for Contract Items, `upload_url`) added; a row missing a needed id gets no link key. */
export function linkRows<T extends Row>(kind: LinkedKind, origin: string, rows: readonly T[]): Array<T & { url?: string; upload_url?: string }> {
  return rows.map(row => ({ ...row, ...absolute(origin, recordPath(kind, row)), ...(kind === 'contract_item' ? upload(origin, row) : {}) }));
}

/** Find matches carry `type`; each links like the record of that kind. */
export function linkFindMatches<T extends Row>(origin: string, matches: readonly T[]): Array<T & { url?: string; upload_url?: string }> {
  return matches.map(match => {
    const kind = match.type === 'site' || match.type === 'project' || match.type === 'contract_item' ? match.type : null;
    return kind ? linkRows(kind, origin, [match])[0]! : { ...match };
  });
}

function scopedPath(scope: Row): string {
  const siteId = text(scope.site_id);
  const projectId = text(scope.project_id);
  if (siteId && projectId) return mapHref({ site: siteId, project: projectId });
  return siteId ? mapHref({ site: siteId }) : '/map';
}

function groupPath(groupBy: unknown, scope: Row, group: Row): string {
  const key = text(group.key) ?? '';
  const siteId = text(group.site_id) ?? text(scope.site_id);
  const unassigned = key === 'unassigned' || key.startsWith('unassigned:');
  switch (groupBy) {
    case 'site': return recordPath('site', { id: key }) ?? scopedPath(scope);
    case 'project':
      if (unassigned) return siteId ? mapHref({ site: siteId }) : scopedPath(scope);
      return recordPath('project', { id: key, site_id: siteId }) ?? scopedPath(scope);
    case 'contract_item':
      if (unassigned) return scopedPath(scope);
      return recordPath('contract_item', { id: key }) ?? scopedPath(scope);
    default: return scopedPath(scope);
  }
}

function linkHighlights(origin: string, scope: Row, highlights: unknown): unknown {
  if (!highlights || typeof highlights !== 'object') return highlights;
  const entry = highlights as Row;
  const event = entry.largest_event;
  if (!event || typeof event !== 'object') return highlights;
  const row = event as Row;
  return { ...entry, largest_event: { ...row, ...absolute(origin, recordPath('event', { ...row, site_id: text(row.site_id) ?? text(scope.site_id) })) } };
}

/** A summary whose groups, group highlights and top-level highlights each carry a `url`. */
export function linkSummary<T extends Row>(origin: string, summary: T): T {
  const scope = (summary.scope && typeof summary.scope === 'object' ? summary.scope : {}) as Row;
  const groups = Array.isArray(summary.groups) ? summary.groups as Row[] : [];
  const linked: Row = {
    ...summary,
    groups: groups.map(group => ({
      ...group,
      url: `${base(origin)}${groupPath(scope.group_by, scope, group)}`,
      ...(group.highlights === undefined ? {} : { highlights: linkHighlights(origin, { ...scope, site_id: text(group.site_id) ?? scope.site_id }, group.highlights) }),
    })),
  };
  if (summary.highlights !== undefined) linked.highlights = linkHighlights(origin, scope, summary.highlights);
  return linked as T;
}
