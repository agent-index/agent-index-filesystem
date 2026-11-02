/**
 * Org path resolution (CI-025, shared library 2.3.0).
 *
 * Builds a map from the org's top-level plain paths (/org-config.json,
 * /members-registry.json, the shared root, each installed collection) to the
 * backend ids recorded in org-config, keeps it in {credential_store}/org-map.json,
 * and lets each adapter seed its own path resolution with it, so callers can use
 * plain paths for org locations on every backend.
 *
 * Contract (technical design §2):
 *   - The map is built ONLY from org-config (plus org_config_id from the local
 *     agent-index.json). No second source of truth.
 *   - resolveOrgMap() NEVER throws. With no usable map it returns map=null and a
 *     reason; the executor then runs the call unmapped, exactly as before 2.3.0.
 *   - The local file is trusted only for the same schema, backend, drive and
 *     org_config_id (the crossorgpath rule).
 *   - No time-based expiry: rebuilt when absent, when a call names a top-level
 *     entry the map lacks and org-config's revision has changed, or when a mapped
 *     read comes back not-found and org-config's revision has changed.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const ORG_MAP_FILENAME = 'org-map.json';
export const ORG_MAP_SCHEMA = 1;

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Tools whose arguments are idempotent reads: a not-found under a mapped prefix
// may be retried once after a map rebuild (technical design §2.4 rule 3).
export const IDEMPOTENT_TOOLS = new Set([
  'aifs_read', 'aifs_exists', 'aifs_stat', 'aifs_list', 'aifs_search',
  'aifs_get_permissions', 'aifs_stat_batch',
]);

// ─── Path helpers ─────────────────────────────────────────────────────

/** True for a plain absolute path (not an `id:` anchor). */
export function isPlainPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//');
}

function normalizePlain(p) {
  let s = '/' + String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.replace(/\/+/g, '/');
  return s === '' ? '/' : s;
}

/** Lower-cased first segment of a plain path, or null for '/' or an id: path. */
export function firstSegment(p) {
  if (!isPlainPath(p)) return null;
  const seg = normalizePlain(p).split('/')[1];
  return seg ? seg.toLowerCase() : null;
}

/**
 * Every path-carrying argument of a tool call: path, source, destination,
 * scope, write_batch entries[].path and stat_batch paths[]. content_file is a
 * LOCAL path and is never included.
 */
export function pathArgs(toolName, args) {
  const out = [];
  if (!args || typeof args !== 'object') return out;
  for (const k of ['path', 'source', 'destination', 'scope']) {
    if (typeof args[k] === 'string') out.push(args[k]);
  }
  if (Array.isArray(args.entries)) {
    for (const e of args.entries) if (e && typeof e.path === 'string') out.push(e.path);
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) if (typeof p === 'string') out.push(p);
  }
  return out;
}

/** True when any path argument is a plain path below the root. */
export function needsOrgMap(toolName, args) {
  return pathArgs(toolName, args).some((p) => firstSegment(p) !== null);
}

// ─── Building the map ─────────────────────────────────────────────────

function sharedPrefixFrom(orgConfig) {
  const raw = orgConfig?.paths?.shared_root;
  if (typeof raw === 'string' && raw.trim().startsWith('/')) {
    const p = normalizePlain(raw.trim());
    if (p !== '/') return p;
  }
  return '/shared';
}

/**
 * Pure: org-config (+ local org_config_id) -> { prefixes, shared_prefix, dropped }.
 * prefixes: { "/shared": {id, kind:"folder"}, "/projects": {...}, "/org-config.json": {id, kind:"file"} }
 */
export function buildPrefixes(orgConfig, { orgConfigId } = {}) {
  const prefixes = {};
  const dropped = [];
  const shared = sharedPrefixFrom(orgConfig);
  const rid = orgConfig?.resource_ids || {};

  if (orgConfigId) prefixes['/org-config.json'] = { id: String(orgConfigId), kind: 'file' };
  if (rid.members_registry) prefixes['/members-registry.json'] = { id: String(rid.members_registry), kind: 'file' };
  if (rid.shared_root) prefixes[shared] = { id: String(rid.shared_root), kind: 'folder' };

  const reserved = new Set(['org-config.json', 'members-registry.json', shared.split('/')[1].toLowerCase()]);
  const seen = new Set(Object.keys(prefixes).map((k) => k.split('/')[1].toLowerCase()));
  for (const c of Array.isArray(orgConfig?.installed_collections) ? orgConfig.installed_collections : []) {
    if (!c || typeof c.name !== 'string' || !c.name || !c.folder_id) continue;
    const name = c.name.trim();
    if (!name || name.includes('/')) { dropped.push({ name, reason: 'invalid_name' }); continue; }
    const lower = name.toLowerCase();
    if (reserved.has(lower)) { dropped.push({ name, reason: 'name_collision' }); continue; }
    if (seen.has(lower)) { dropped.push({ name, reason: 'duplicate_name' }); continue; }
    seen.add(lower);
    prefixes['/' + name] = { id: String(c.folder_id), kind: 'folder' };
  }
  return { prefixes, shared_prefix: shared, dropped };
}

/** Longest-prefix match of a plain path; first segment matched case-insensitively. */
export function matchOrgPrefix(map, path) {
  if (!map || !isPlainPath(path)) return null;
  const norm = normalizePlain(path);
  const parts = norm.split('/').filter(Boolean);
  let best = null;
  for (const key of Object.keys(map.prefixes || {})) {
    const kp = key.split('/').filter(Boolean);
    if (kp.length === 0 || kp.length > parts.length) continue;
    let ok = kp[0].toLowerCase() === parts[0].toLowerCase();
    for (let i = 1; ok && i < kp.length; i++) ok = kp[i] === parts[i];
    if (ok && (!best || kp.length > best.depth)) {
      best = { prefix: key, depth: kp.length, entry: map.prefixes[key], rest: parts.slice(kp.length).join('/') };
    }
  }
  if (!best) return null;
  return { prefix: best.prefix, id: best.entry.id, kind: best.entry.kind, rest: best.rest };
}

/**
 * Rewrite only the CASE of a mapped first segment to the map's canonical key
 * (so "/Shared/x" seeds and resolves like "/shared/x"). Everything else is
 * returned untouched.
 */
export function canonicalizePath(map, path) {
  const m = matchOrgPrefix(map, path);
  if (!m) return path;
  return m.rest ? `${m.prefix}/${m.rest}` : m.prefix;
}

/** Apply canonicalizePath to every path argument of a call (returns a new args object). */
export function canonicalizeArgs(map, toolName, args) {
  if (!map || !args || typeof args !== 'object') return args;
  const out = { ...args };
  for (const k of ['path', 'source', 'destination', 'scope']) {
    if (typeof out[k] === 'string') out[k] = canonicalizePath(map, out[k]);
  }
  if (Array.isArray(out.entries)) {
    out.entries = out.entries.map((e) => (e && typeof e.path === 'string' ? { ...e, path: canonicalizePath(map, e.path) } : e));
  }
  if (Array.isArray(out.paths)) {
    out.paths = out.paths.map((p) => (typeof p === 'string' ? canonicalizePath(map, p) : p));
  }
  return out;
}

/** True when any path argument falls under a mapped prefix. */
export function touchesMappedPrefix(map, toolName, args) {
  return pathArgs(toolName, args).some((p) => matchOrgPrefix(map, p) !== null);
}

/** True when a path IS a mapped prefix itself (deleting it is refused). */
export function isProtectedOrgPath(map, path) {
  const m = matchOrgPrefix(map, path);
  return !!m && m.rest === '';
}

export function mimeTypeFor(entry) {
  return entry?.kind === 'folder' ? FOLDER_MIME : (entry?.mimeType || 'application/octet-stream');
}

// ─── Local file ───────────────────────────────────────────────────────

function identity(config) {
  const conn = config?.connection || {};
  return {
    backend: config?.backend || null,
    drive_id: conn.drive_id || null,
    org_config_id: conn.org_config_id || null,
  };
}

async function readMapFile(credentialStore, config) {
  try {
    const data = JSON.parse(await readFile(join(credentialStore, ORG_MAP_FILENAME), 'utf-8'));
    const id = identity(config);
    if (data.schema !== ORG_MAP_SCHEMA) return null;
    if ((data.backend || null) !== id.backend) return null;
    if ((data.drive_id || null) !== id.drive_id) return null;
    if ((data.org_config_id || null) !== id.org_config_id) return null;
    if (!data.prefixes || typeof data.prefixes !== 'object') return null;
    data.misses = data.misses && typeof data.misses === 'object' ? data.misses : {};
    return data;
  } catch {
    return null;
  }
}

/** Atomic write (temp file + rename). Non-fatal on failure. */
export async function saveOrgMap(credentialStore, map) {
  if (!map) return;
  const target = join(credentialStore, ORG_MAP_FILENAME);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, JSON.stringify(map), 'utf-8');
    await rename(tmp, target);
  } catch {
    // Non-fatal: the next call rebuilds.
  }
}

// ─── Reading org-config through the adapter ───────────────────────────

function orgConfigAddress(config) {
  const conn = config?.connection || {};
  if (config?.backend === 'gdrive') return conn.org_config_id ? `id:${conn.org_config_id}` : null;
  return '/org-config.json';
}

async function orgConfigRevision(adapter, address) {
  const st = await adapter.stat(address);
  return st?.revision ?? null;
}

/**
 * Validate folder entries: each must live in the org's drive (technical design §2.3).
 * Entries that fail the check, or can't be stat'ed, are dropped (the path then
 * resolves as it did before 2.3.0).
 */
async function validatePrefixes(adapter, config, prefixes, dropped, warn) {
  const orgDrive = config?.connection?.drive_id || null;
  if (!orgDrive || typeof adapter.stat !== 'function') return { prefixes, complete: true };
  const onedrive = config?.backend === 'onedrive';
  const sameDrive = (d) => (onedrive ? String(d).toLowerCase() === String(orgDrive).toLowerCase() : d === orgDrive);
  const out = {};
  let complete = true;
  const keys = Object.keys(prefixes);
  const results = [];
  // Bounded concurrency (4): avoid rate limits on orgs with many collections.
  for (let i = 0; i < keys.length; i += 4) {
    const batch = keys.slice(i, i + 4);
    results.push(...await Promise.all(batch.map(async (k) => {
      const e = prefixes[k];
      if (e.kind !== 'folder') return { k, ok: true };
      try {
        // OneDrive: a drive-qualified anchor goes straight to the org's drive
        // (a bare id: would probe the member's own drive first).
        const st = await adapter.stat(onedrive ? `id:${orgDrive}:${e.id}` : `id:${e.id}`);
        const d = st?.drive_id ?? null;
        // d === null: the backend reports no drive (a My Drive item), not the org's Shared Drive.
        if (d !== null && sameDrive(d)) return { k, ok: true };
        return { k, ok: false, reason: 'outside_org_drive', detail: d };
      } catch (err) {
        return { k, ok: false, reason: 'unverified', detail: err?.code || 'stat_failed', transient: true };
      }
    })));
  }
  for (const r of results) {
    if (r.ok) { out[r.k] = prefixes[r.k]; continue; }
    if (r.transient) complete = false;
    dropped.push({ prefix: r.k, reason: r.reason, detail: r.detail });
    warn(`aifs: org map: dropped ${r.k} (${r.reason}${r.detail ? `: ${r.detail}` : ''})`);
  }
  return { prefixes: out, complete };
}

async function build(ctx) {
  const { config, adapter, warn } = ctx;
  const address = orgConfigAddress(config);
  if (!address) return { map: null, reason: 'no_org_config_id' };
  let revision = null;
  try { revision = await orgConfigRevision(adapter, address); } catch (err) {
    return { map: null, reason: `org_config_unreadable:${err?.code || err?.message || 'error'}` };
  }
  let orgConfig;
  try {
    const raw = await adapter.read(address);
    orgConfig = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch (err) {
    return { map: null, reason: `org_config_unreadable:${err?.code || 'parse_error'}` };
  }
  const id = identity(config);
  const { prefixes, shared_prefix, dropped } = buildPrefixes(orgConfig, { orgConfigId: id.org_config_id });
  for (const d of dropped) warn(`aifs: org map: dropped collection "${d.name}" (${d.reason})`);
  const { prefixes: validated, complete } = await validatePrefixes(adapter, config, prefixes, dropped, warn);
  const map = {
    schema: ORG_MAP_SCHEMA,
    ...id,
    org_config_revision: revision,
    built_at: new Date().toISOString(),
    shared_prefix,
    prefixes: validated,
    misses: {},
  };
  // A map with an entry dropped for a transient reason (rate limit, network) is
  // used for this call but not saved, so the next call verifies again.
  return { map, reason: null, rebuilt: true, persist: complete };
}

/**
 * Get the org map for this call. NEVER throws.
 *
 * mode:
 *   'normal'         — use the local file if valid, else build.
 *   'missing-prefix' — the call names top-level `segment` that the map lacks:
 *                      one org-config stat; rebuild if the revision changed;
 *                      record the miss for this revision either way.
 *   'not-found'      — a mapped read came back not-found: one org-config stat;
 *                      rebuild (and report rebuilt:true) only if the revision changed.
 *
 * Returns { map | null, reason | null, rebuilt: boolean }.
 */
export async function resolveOrgMap({ config, adapter, credentialStore, mode = 'normal', segment = null, warn = () => {} }) {
  const ctx = { config, adapter, warn };
  try {
    const cached = await readMapFile(credentialStore, config);

    if (!cached) {
      const r = await build(ctx);
      if (r.map && mode === 'missing-prefix' && segment && !matchOrgPrefix(r.map, '/' + segment)) {
        r.map.misses[segment.toLowerCase()] = r.map.org_config_revision;
      }
      if (r.map && r.persist) await saveOrgMap(credentialStore, r.map);
      return { map: r.map, reason: r.reason, rebuilt: !!r.map };
    }

    if (mode === 'normal') return { map: cached, reason: null, rebuilt: false };

    if (mode === 'missing-prefix') {
      const seg = (segment || '').toLowerCase();
      if (seg && cached.misses[seg] && cached.misses[seg] === cached.org_config_revision) {
        return { map: cached, reason: null, rebuilt: false };
      }
    }

    const address = orgConfigAddress(config);
    let revision;
    try { revision = await orgConfigRevision(adapter, address); } catch {
      return { map: cached, reason: null, rebuilt: false };
    }
    if (revision !== null && revision !== cached.org_config_revision) {
      const r = await build(ctx);
      if (r.map) {
        if (mode === 'missing-prefix' && segment && !matchOrgPrefix(r.map, '/' + segment)) {
          r.map.misses[segment.toLowerCase()] = r.map.org_config_revision;
        }
        if (r.persist) await saveOrgMap(credentialStore, r.map);
        return { map: r.map, reason: null, rebuilt: true };
      }
      return { map: cached, reason: null, rebuilt: false };
    }
    if (mode === 'missing-prefix' && segment) {
      cached.misses[segment.toLowerCase()] = cached.org_config_revision;
      await saveOrgMap(credentialStore, cached);
    }
    return { map: cached, reason: null, rebuilt: false };
  } catch (err) {
    return { map: null, reason: `org_map_error:${err?.message || 'error'}`, rebuilt: false };
  }
}

/** The top-level segments a call names that the map doesn't hold. */
export function missingSegments(map, toolName, args) {
  const out = new Set();
  for (const p of pathArgs(toolName, args)) {
    const seg = firstSegment(p);
    if (!seg) continue;
    if (!matchOrgPrefix(map, p)) out.add(seg);
  }
  return [...out];
}
