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
