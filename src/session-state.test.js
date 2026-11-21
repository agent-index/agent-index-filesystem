// CI-025 session state — unit tests (technical design §4, §5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPendingAuth, writePendingAuth, clearPendingAuth, reusedAuthResponse,
  writeIdentity, readIdentity, memberHash, bootstrapState, PENDING_AUTH_MAX_AGE_MS,
} from './session-state.js';

const dir = () => mkdtemp(join(tmpdir(), 'sess-'));

test('pending sign-in is reused for 10 minutes, then expires; clear removes it', async () => {
  const d = await dir();
  assert.equal(await readPendingAuth(d), null);
  await writePendingAuth(d, { auth_url: 'https://x/auth' }, 1000);
  assert.equal((await readPendingAuth(d, 1000 + 60_000)).auth_url, 'https://x/auth');
  assert.equal(await readPendingAuth(d, 1000 + PENDING_AUTH_MAX_AGE_MS), null);
  await clearPendingAuth(d);
  assert.equal(await readPendingAuth(d, 1001), null);
  const r = reusedAuthResponse({ auth_url: 'https://x/auth' });
  assert.equal(r.reused, true);
  assert.equal(r.status, 'awaiting_code');
});

test('identity is saved lower-cased and only when it looks like an email', async () => {
  const d = await dir();
  assert.equal(await writeIdentity(d, 'unknown'), false);
  await writeIdentity(d, 'Member.Three@Agent-Index.ai');
  assert.equal(await readIdentity(d), 'member.three@agent-index.ai');
  assert.equal(memberHash('Member.Three@Agent-Index.ai'), memberHash('member.three@agent-index.ai'));
  assert.equal(memberHash('a@b.c').length, 16);
});

test('bootstrap state: needs_setup / needs_auth / ready from local files only', async () => {
  const d = await dir();
  const cfg = join(d, 'agent-index.json');
  assert.equal(bootstrapState({ configPath: cfg, authenticated: true, email: 'a@b.c' }).bootstrap, 'needs_setup');
  await writeFile(cfg, JSON.stringify({ remote_filesystem: {} }));
  assert.equal(bootstrapState({ configPath: cfg, authenticated: true, email: 'a@b.c' }).reason, 'no_backend_configured');
  await writeFile(cfg, JSON.stringify({ remote_filesystem: { backend: 'gdrive' } }));
  assert.equal(bootstrapState({ configPath: cfg, authenticated: false, email: 'a@b.c' }).bootstrap, 'needs_auth');
  assert.equal(bootstrapState({ configPath: cfg, authenticated: true, email: 'unknown' }).bootstrap, 'needs_auth');
  const s1 = bootstrapState({ configPath: cfg, authenticated: true, email: 'a@b.c' });
  assert.equal(s1.bootstrap, 'needs_setup');
  assert.equal(s1.reason, 'no_member_workspace');
  await mkdir(join(d, 'members', s1.member_hash), { recursive: true });
  await writeFile(join(d, 'members', s1.member_hash, 'member-index.json'), '{}');
  assert.deepEqual(bootstrapState({ configPath: cfg, authenticated: true, email: 'A@B.C' }), { bootstrap: 'ready', member_hash: s1.member_hash });
});

test('bootstrap state: a signed-in account that is not the agent-index email (finding 108)', async () => {
  const d = await dir();
  const cfg = join(d, 'agent-index.json');
  await writeFile(cfg, JSON.stringify({ remote_filesystem: { backend: 'onedrive' } }));
  const ws = (h) => mkdir(join(d, 'members', h), { recursive: true }).then(() => writeFile(join(d, 'members', h, 'member-index.json'), '{}'));
  const upn = 'billsalak@agentindex.onmicrosoft.com';
  // no workspace at all: the only needs_setup case
  assert.equal(bootstrapState({ configPath: cfg, authenticated: true, email: upn }).bootstrap, 'needs_setup');
  // a members/ folder without member-index.json is not a workspace
  await mkdir(join(d, 'members', 'ffffffffffffffff'), { recursive: true });
  assert.equal(bootstrapState({ configPath: cfg, authenticated: true, email: upn }).bootstrap, 'needs_setup');
  // one workspace under the agent-index email's hash: ready with that workspace, flagged
  const real = memberHash('bill@agent-index.ai');
  await ws(real);
  assert.deepEqual(bootstrapState({ configPath: cfg, authenticated: true, email: upn }), {
    bootstrap: 'ready', member_hash: real, identity_match: false,
    reason: 'signed_in_account_differs', signed_in_hash: memberHash(upn),
  });
  // the account's own workspace wins when it exists
  assert.deepEqual(bootstrapState({ configPath: cfg, authenticated: true, email: 'bill@agent-index.ai' }), { bootstrap: 'ready', member_hash: real });
  // several workspaces and no match: ready, member_hash null, list the candidates
  const other = memberHash('member.three@agent-index.ai');
  await ws(other);
  const s = bootstrapState({ configPath: cfg, authenticated: true, email: upn });
  assert.equal(s.bootstrap, 'ready');
  assert.equal(s.member_hash, null);
  assert.equal(s.reason, 'several_workspaces');
  assert.deepEqual(s.local_member_hashes, [real, other].sort());
  // local.members_root is honoured
  await writeFile(cfg, JSON.stringify({ remote_filesystem: { backend: 'onedrive' }, local: { members_root: 'ws/' } }));
  assert.equal(bootstrapState({ configPath: cfg, authenticated: true, email: upn }).bootstrap, 'needs_setup');
});
