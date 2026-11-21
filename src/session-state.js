/**
 * Session state shared by both adapters' executors (CI-025, shared library 2.3.0).
 *
 *   - Pending sign-in: aifs_authenticate(start) returns the sign-in already in
 *     progress (under 10 minutes old) instead of starting a new one, unless
 *     force:true (technical design §4).
 *   - Identity: the signed-in member's email, saved locally so later checks
 *     (and the session hook) need no network call (§4, §5).
 *   - Bootstrap state: ready | needs_auth | needs_setup, computed from local
 *     files only, returned by aifs_auth_status (§5).
 *
 * Everything here is best-effort and never throws to the caller.
 */
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const PENDING_AUTH_FILENAME = 'pending-auth.json';
export const IDENTITY_FILENAME = 'identity.json';
export const PENDING_AUTH_MAX_AGE_MS = 10 * 60 * 1000;

async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(data), 'utf-8');
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

// ─── Pending sign-in ──────────────────────────────────────────────────

/** The pending sign-in if it is younger than 10 minutes, else null. */
export async function readPendingAuth(credentialStore, now = Date.now()) {
  const p = await readJson(join(credentialStore, PENDING_AUTH_FILENAME));
  if (!p || typeof p.auth_url !== 'string' || typeof p.created !== 'number') return null;
  if (now - p.created >= PENDING_AUTH_MAX_AGE_MS) return null;
  return p;
}

export async function writePendingAuth(credentialStore, { auth_url, message }, now = Date.now()) {
  return writeAtomic(join(credentialStore, PENDING_AUTH_FILENAME), { auth_url, message: message || null, created: now });
}

export async function clearPendingAuth(credentialStore) {
  // The Cowork mount can refuse deletes; overwrite with an expired record as a fallback.
  const path = join(credentialStore, PENDING_AUTH_FILENAME);
  try { await unlink(path); } catch { await writeAtomic(path, { created: 0 }); }
}

/** The response returned when a pending sign-in is reused. */
export function reusedAuthResponse(pending) {
  return {
    status: 'awaiting_code',
    reused: true,
    auth_url: pending.auth_url,
    message:
      'A sign-in is already in progress; this is the same link. Open it, sign in, then paste the full ' +
      'redirected URL (or the bare code) back and call aifs_authenticate with action:"complete". ' +
      'To start over instead (for example to use a different account), call action:"start" with force:true.',
  };
}

// ─── Identity ─────────────────────────────────────────────────────────

export async function writeIdentity(credentialStore, email) {
  if (typeof email !== 'string' || !email.includes('@')) return false;
  return writeAtomic(join(credentialStore, IDENTITY_FILENAME), { email: email.toLowerCase(), saved: new Date().toISOString() });
}

export async function readIdentity(credentialStore) {
  const d = await readJson(join(credentialStore, IDENTITY_FILENAME));
  return d && typeof d.email === 'string' ? d.email : null;
}

export function memberHash(email, length = 16) {
  return createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, length);
}

// ─── Bootstrap state ──────────────────────────────────────────────────

/** Hashes of the local member workspaces (members/{hash}/member-index.json), sorted. */
export function localWorkspaces(installDir, membersRoot = 'members') {
  try {
    const root = join(installDir, membersRoot);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'member-index.json')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * ready | needs_auth | needs_setup, from local state only.
 *   configPath    path to agent-index.json (AIFS_CONFIG_PATH)
 *   authenticated whether the adapter holds a usable credential
 *   email         the signed-in account (from the auth status or identity.json)
 *
 * The signed-in account is the backend's (a Microsoft UPN, a Google account), which
 * need not be the member's agent-index email, so its hash can miss an existing
 * workspace (finding 108). needs_setup therefore means "no member workspace on this
 * install at all", the same rule as CLAUDE.md's fallback. When the account's hash
 * misses: one local workspace -> ready with that workspace (identity_match false);
 * several -> ready with member_hash null, to be resolved from the member's
 * agent-index email (CLAUDE.md § Identity Resolution).
 */
export function bootstrapState({ configPath, authenticated, email }) {
  try {
    if (!configPath || !existsSync(configPath)) {
      return { bootstrap: 'needs_setup', reason: 'no_agent_index_json' };
    }
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* treat as unconfigured */ }
    if (!cfg?.remote_filesystem?.backend) {
      return { bootstrap: 'needs_setup', reason: 'no_backend_configured' };
    }
    if (!authenticated) return { bootstrap: 'needs_auth', reason: 'not_signed_in' };
    if (!email || email === 'unknown') return { bootstrap: 'needs_auth', reason: 'identity_unknown' };
    const length = Number(cfg?.identity_resolution?.hash_length) || 16;
    const hash = memberHash(email, length);
    const installDir = dirname(configPath);
    const membersRoot = (typeof cfg?.local?.members_root === 'string' && cfg.local.members_root) || 'members';
    if (existsSync(join(installDir, membersRoot, hash, 'member-index.json'))) {
      return { bootstrap: 'ready', member_hash: hash };
    }
    const workspaces = localWorkspaces(installDir, membersRoot);
    if (workspaces.length === 0) {
      return { bootstrap: 'needs_setup', reason: 'no_member_workspace', member_hash: hash };
    }
    if (workspaces.length === 1) {
      return {
        bootstrap: 'ready', member_hash: workspaces[0], identity_match: false,
        reason: 'signed_in_account_differs', signed_in_hash: hash,
      };
    }
    return {
      bootstrap: 'ready', member_hash: null, identity_match: false,
      reason: 'several_workspaces', signed_in_hash: hash, local_member_hashes: workspaces,
    };
  } catch (err) {
    return { bootstrap: 'needs_setup', reason: `check_failed:${err?.message || 'error'}` };
  }
}
