// CI-025 org path resolution — unit tests (technical design §13, shared library).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPrefixes, matchOrgPrefix, canonicalizeArgs, pathArgs, needsOrgMap,
  touchesMappedPrefix, isProtectedOrgPath, missingSegments, resolveOrgMap,
  ORG_MAP_FILENAME, mimeTypeFor,
} from './org-map.js';

const ORG = {
  resource_ids: { shared_root: 'SR', members_registry: 'REG' },
  installed_collections: [
    { name: 'agent-index-core', folder_id: 'CORE' },
    { name: 'projects', folder_id: 'PRJ' },
    { name: 'capture' },                               // no folder_id -> absent
    { name: 'Shared', folder_id: 'BAD' },              // collides with the shared root
  ],
};

const gconfig = (over = {}) => ({ backend: 'gdrive', connection: { drive_id: 'D1', org_config_id: 'OC', ...over } });

function fakeAdapter({ org = ORG, revision = 'r1', drives = {}, failStat = new Set(), failRead = false } = {}) {
  const calls = { stat: [], read: [] };
  return {
    calls,
    org, revision,
    async stat(p) {
      calls.stat.push(p);
      if (failStat.has(p)) throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' });
      if (p === 'id:OC' || p === '/org-config.json') return { revision: this.revision };
      const id = p.replace(/^id:/, '');
      return { drive_id: drives[id] ?? 'D1' };
    },
    async read(p) {
      calls.read.push(p);
      if (failRead) throw Object.assign(new Error('nope'), { code: 'NOT_AUTHENTICATED' });
      return JSON.stringify(this.org);
    },
  };
}

const store = () => mkdtemp(join(tmpdir(), 'orgmap-'));

// ─── pure helpers ─────────────────────────────────────────────────────

test('buildPrefixes: maps org-config ids; skips entries with no id; rejects a collision', () => {
  const { prefixes, dropped, shared_prefix } = buildPrefixes(ORG, { orgConfigId: 'OC' });
  assert.equal(shared_prefix, '/shared');
  assert.deepEqual(Object.keys(prefixes).sort(),
    ['/agent-index-core', '/members-registry.json', '/org-config.json', '/projects', '/shared']);
  assert.equal(prefixes['/shared'].id, 'SR');
  assert.equal(prefixes['/org-config.json'].kind, 'file');
  assert.ok(dropped.some((d) => d.name === 'Shared' && d.reason === 'name_collision'));
});

test('buildPrefixes: an older org without resource_ids just has fewer prefixes', () => {
  const { prefixes } = buildPrefixes({ installed_collections: [{ name: 'projects', folder_id: 'P' }] }, { orgConfigId: 'OC' });
  assert.deepEqual(Object.keys(prefixes).sort(), ['/org-config.json', '/projects']);
});

test('buildPrefixes: a customised shared_root is honoured', () => {
  const { prefixes, shared_prefix } = buildPrefixes({ paths: { shared_root: '/org-shared/' }, resource_ids: { shared_root: 'SR' } }, {});
  assert.equal(shared_prefix, '/org-shared');
  assert.equal(prefixes['/org-shared'].id, 'SR');
});

test('matchOrgPrefix: segment boundaries and case-insensitive first segment', () => {
  const map = { prefixes: buildPrefixes(ORG, { orgConfigId: 'OC' }).prefixes };
  assert.equal(matchOrgPrefix(map, '/shared/a/b').prefix, '/shared');
  assert.equal(matchOrgPrefix(map, '/shared/a/b').rest, 'a/b');
  assert.equal(matchOrgPrefix(map, '/shared-archive/x'), null);
  assert.equal(matchOrgPrefix(map, '/projects-index/x'), null);
  assert.equal(matchOrgPrefix(map, '/Projects/api/x.md').prefix, '/projects');
  assert.equal(matchOrgPrefix(map, 'id:SR/a'), null);
  assert.equal(matchOrgPrefix(map, '/CLAUDE.md'), null);
});

test('canonicalizeArgs: only the case of a mapped first segment changes', () => {
  const map = { prefixes: buildPrefixes(ORG, { orgConfigId: 'OC' }).prefixes };
  const out = canonicalizeArgs(map, 'aifs_write_batch', {
    entries: [{ path: '/Shared/X/y.json', content: '1' }, { path: 'id:Z/k', content: '2' }],
  });
  assert.equal(out.entries[0].path, '/shared/X/y.json');
  assert.equal(out.entries[1].path, 'id:Z/k');
  assert.equal(canonicalizeArgs(map, 'aifs_read', { path: '/CLAUDE.md' }).path, '/CLAUDE.md');
});

test('pathArgs / needsOrgMap cover every path-carrying argument', () => {
  assert.deepEqual(pathArgs('aifs_copy', { source: '/a', destination: '/b' }), ['/a', '/b']);
  assert.deepEqual(pathArgs('aifs_search', { scope: '/shared' }), ['/shared']);
  assert.deepEqual(pathArgs('aifs_stat_batch', { paths: ['/a', 'id:x'] }), ['/a', 'id:x']);
  assert.deepEqual(pathArgs('aifs_write', { path: '/a', content_file: '/local/x' }), ['/a']);
  assert.equal(needsOrgMap('aifs_read', { path: 'id:OC' }), false);
  assert.equal(needsOrgMap('aifs_list', { path: '/' }), false);
  assert.equal(needsOrgMap('aifs_read', { path: '/shared/x' }), true);
});

test('protected prefixes and missing segments', () => {
  const map = { prefixes: buildPrefixes(ORG, { orgConfigId: 'OC' }).prefixes };
  assert.equal(isProtectedOrgPath(map, '/shared'), true);
  assert.equal(isProtectedOrgPath(map, '/shared/'), true);
  assert.equal(isProtectedOrgPath(map, '/Projects'), true);
  assert.equal(isProtectedOrgPath(map, '/shared/x'), false);
  assert.deepEqual(missingSegments(map, 'aifs_read', { path: '/capture/api/x.md' }), ['capture']);
  assert.equal(touchesMappedPrefix(map, 'aifs_copy', { source: 'id:z', destination: '/shared/q' }), true);
  assert.equal(mimeTypeFor({ kind: 'folder' }), 'application/vnd.google-apps.folder');
});

// ─── resolveOrgMap ────────────────────────────────────────────────────

test('resolveOrgMap: builds once, then serves the local file with no remote calls', async () => {
  const dir = await store();
  const a = fakeAdapter();
  const r1 = await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir });
  assert.equal(r1.rebuilt, true);
  assert.equal(r1.map.prefixes['/shared'].id, 'SR');
  const reads = a.calls.read.length;
  const stats = a.calls.stat.length;
  const r2 = await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir });
  assert.equal(r2.rebuilt, false);
  assert.equal(a.calls.read.length, reads);
  assert.equal(a.calls.stat.length, stats);
  assert.ok(a.calls.read.includes('id:OC'));
});

test('resolveOrgMap: a folder outside the org drive is dropped (wrong-org protection)', async () => {
  const dir = await store();
  const msgs = [];
  const r = await resolveOrgMap({ config: gconfig(), adapter: fakeAdapter({ drives: { PRJ: 'OTHER' } }), credentialStore: dir, warn: (m) => msgs.push(m) });
  assert.equal(r.map.prefixes['/projects'], undefined);
  assert.ok(r.map.prefixes['/shared']);
  assert.ok(msgs.some((m) => m.includes('/projects') && m.includes('outside_org_drive')));
});

test('resolveOrgMap: an unverifiable folder is dropped for this call and the map is NOT saved', async () => {
  const dir = await store();
  const r = await resolveOrgMap({ config: gconfig(), adapter: fakeAdapter({ failStat: new Set(['id:CORE']) }), credentialStore: dir });
  assert.equal(r.map.prefixes['/agent-index-core'], undefined);
  assert.ok(r.map.prefixes['/projects']);
  // Next call (the stat now succeeds) verifies again and gets the entry back.
  const r2 = await resolveOrgMap({ config: gconfig(), adapter: fakeAdapter(), credentialStore: dir });
  assert.equal(r2.rebuilt, true);
  assert.ok(r2.map.prefixes['/agent-index-core']);
});

test('resolveOrgMap: OneDrive checks folders by drive-qualified id, drive ids compared case-insensitively', async () => {
  const dir = await store();
  const a = fakeAdapter({ drives: { 'd1:PRJ': 'd1' } });
  a.stat = async function (p) {
    this.calls.stat.push(p);
    if (p === '/org-config.json') return { revision: 'r1' };
    return { drive_id: 'd1' };   // lower-case form of the configured 'D1'
  };
  const r = await resolveOrgMap({ config: { backend: 'onedrive', connection: { drive_id: 'D1' } }, adapter: a, credentialStore: dir });
  assert.ok(r.map.prefixes['/projects']);
  assert.ok(a.calls.stat.includes('id:D1:PRJ'));
});

test('resolveOrgMap: never throws; returns null with a reason', async () => {
  const dir = await store();
  const noId = await resolveOrgMap({ config: { backend: 'gdrive', connection: { drive_id: 'D1' } }, adapter: fakeAdapter(), credentialStore: dir });
  assert.equal(noId.map, null);
  assert.equal(noId.reason, 'no_org_config_id');
  const unread = await resolveOrgMap({ config: gconfig(), adapter: fakeAdapter({ failRead: true }), credentialStore: dir });
  assert.equal(unread.map, null);
  assert.match(unread.reason, /^org_config_unreadable/);
  const broken = await resolveOrgMap({ config: gconfig(), adapter: { stat: () => { throw new Error('x'); } }, credentialStore: dir });
  assert.equal(broken.map, null);
});

test('resolveOrgMap: the local file is ignored for another org, backend or schema', async () => {
  const dir = await store();
  await resolveOrgMap({ config: gconfig(), adapter: fakeAdapter(), credentialStore: dir });
  const a = fakeAdapter();
  const other = await resolveOrgMap({ config: gconfig({ drive_id: 'D2' }), adapter: a, credentialStore: dir });
  assert.equal(other.rebuilt, true);
  const f = JSON.parse(await readFile(join(dir, ORG_MAP_FILENAME), 'utf-8'));
  f.schema = 99;
  await writeFile(join(dir, ORG_MAP_FILENAME), JSON.stringify(f));
  const again = await resolveOrgMap({ config: gconfig({ drive_id: 'D2' }), adapter: fakeAdapter(), credentialStore: dir });
  assert.equal(again.rebuilt, true);
});

test('rule 2 (missing prefix): one stat; rebuild only when org-config changed; miss remembered per revision', async () => {
  const dir = await store();
  const a = fakeAdapter();
  await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir });
  const s0 = a.calls.stat.length;
  const r1 = await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir, mode: 'missing-prefix', segment: 'CLAUDE.md' });
  assert.equal(r1.rebuilt, false);
  assert.equal(a.calls.stat.length, s0 + 1);
  const r2 = await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir, mode: 'missing-prefix', segment: 'claude.md' });
  assert.equal(r2.rebuilt, false);
  assert.equal(a.calls.stat.length, s0 + 1, 'a remembered miss costs nothing');
  // A collection installed since: org-config's revision changed.
  a.revision = 'r2';
  a.org = { ...ORG, installed_collections: [...ORG.installed_collections, { name: 'capture2', folder_id: 'CAP' }] };
  const r3 = await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir, mode: 'missing-prefix', segment: 'capture2' });
  assert.equal(r3.rebuilt, true);
  assert.equal(r3.map.prefixes['/capture2'].id, 'CAP');
});

test('rule 3 (mapped not-found): rebuild only when org-config changed', async () => {
  const dir = await store();
  const a = fakeAdapter();
  await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir });
  const same = await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir, mode: 'not-found' });
  assert.equal(same.rebuilt, false);
  a.revision = 'r9';
  a.org = { ...ORG, installed_collections: [{ name: 'projects', folder_id: 'PRJ2' }] };
  const changed = await resolveOrgMap({ config: gconfig(), adapter: a, credentialStore: dir, mode: 'not-found' });
  assert.equal(changed.rebuilt, true);
  assert.equal(changed.map.prefixes['/projects'].id, 'PRJ2');
});

test('OneDrive: org-config is read by path; no org_config_id needed', async () => {
  const dir = await store();
  const a = fakeAdapter();
  const r = await resolveOrgMap({ config: { backend: 'onedrive', connection: { drive_id: 'D1' } }, adapter: a, credentialStore: dir });
  assert.ok(r.map);
  assert.ok(a.calls.read.includes('/org-config.json'));
  assert.equal(r.map.prefixes['/org-config.json'], undefined);
  assert.equal(r.map.prefixes['/shared'].id, 'SR');
});
