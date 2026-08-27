import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { base64UrlToBytes, mineNonce, PROTOCOL_VERSION, serializeNonce } from '@staticlayer/protocol';
import { SECRETS, spawnWorker } from './worker.ts';

const BASE = 'http://localhost';

/**
 * Nested replies (Round 21.15): parent_id validation, public tree read with
 * parent filtering (pending parents hide replies; deleted parents keep them),
 * and the admin queue surfacing the parent nickname.
 */

async function login(mf: Miniflare): Promise<{ cookie: string; csrf: string }> {
  const res = await mf.dispatchFetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: SECRETS.ADMIN_SECRET }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const data = (await res.json()) as { csrf?: string };
  return { cookie, csrf: data.csrf as string };
}

async function postComment(
  mf: Miniflare,
  nickname: string,
  body: string,
  articlePath = '/blog/x',
  parentId?: string,
): Promise<{ status: number; id?: string }> {
  const challengeRes = await mf.dispatchFetch(
    `${BASE}/api/comments/challenge?hostContext=example.com&articlePath=${encodeURIComponent(articlePath)}`,
  );
  if (challengeRes.status !== 200) return { status: challengeRes.status };
  const challenge = (await challengeRes.json()) as {
    challengeId: string; hostContext: string; articlePath: string;
    difficulty: number; expiresAt: number; signature: string;
  };
  const nonce = await mineNonce(
    {
      version: PROTOCOL_VERSION,
      hostContext: challenge.hostContext,
      articlePath: challenge.articlePath,
      nickname,
      body,
      challengeId: base64UrlToBytes(challenge.challengeId),
    },
    challenge.difficulty,
  );
  const payload: Record<string, unknown> = {
    challengeId: challenge.challengeId,
    hostContext: challenge.hostContext,
    articlePath: challenge.articlePath,
    nickname,
    body,
    difficulty: challenge.difficulty,
    expiresAt: challenge.expiresAt,
    signature: challenge.signature,
    nonce: serializeNonce(nonce),
  };
  if (parentId) payload.parentId = parentId;
  const res = await mf.dispatchFetch(`${BASE}/api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { comment?: { id: string } };
  return { status: res.status, id: data.comment?.id };
}

async function approve(mf: Miniflare, cookie: string, csrf: string, id: string): Promise<void> {
  const res = await mf.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
    method: 'PATCH',
    headers: { cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  expect(res.status).toBe(200);
}

async function delComment(mf: Miniflare, cookie: string, csrf: string, id: string): Promise<void> {
  const res = await mf.dispatchFetch(`${BASE}/api/admin/comments/${id}`, {
    method: 'DELETE',
    headers: { cookie, 'X-CSRF-Token': csrf },
  });
  expect(res.status).toBe(200);
}

interface PublicComment {
  id: string;
  parent_id: string | null;
  nickname: string;
}

async function listPublic(mf: Miniflare): Promise<PublicComment[]> {
  const res = await mf.dispatchFetch(`${BASE}/api/comments?article_path=%2Fblog%2Fx&host_context=example.com`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as { comments: PublicComment[] };
  return data.comments;
}

describe('nested replies — API', () => {
  let mf: Miniflare | undefined;
  let auth: { cookie: string; csrf: string };
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it('stores a reply with parent_id after valid PoW and both appear when approved', async () => {
    mf = await spawnWorker();
    auth = await login(mf);

    const root = await postComment(mf, 'Root', 'first');
    expect(root.status).toBe(200);
    await approve(mf, auth.cookie, auth.csrf, root.id!);

    const reply = await postComment(mf, 'Child', 'reply!', '/blog/x', root.id);
    expect(reply.status).toBe(200);
    await approve(mf, auth.cookie, auth.csrf, reply.id!);

    const comments = await listPublic(mf);
    expect(comments).toHaveLength(2);
    const rootPub = comments.find((c) => c.id === root.id);
    const replyPub = comments.find((c) => c.id === reply.id);
    expect(rootPub!.parent_id).toBeNull();
    expect(replyPub!.parent_id).toBe(root.id);
  });

  it('rejects a reply to a missing parent', async () => {
    mf = await spawnWorker();
    const res = await postComment(mf, 'X', 'orphan', '/blog/x', 'does-not-exist');
    expect(res.status).toBe(400);
  });

  it('rejects a reply to a comment that is still pending', async () => {
    mf = await spawnWorker();
    const root = await postComment(mf, 'Root', 'pending root');
    expect(root.status).toBe(200);
    const reply = await postComment(mf, 'Child', 'too early', '/blog/x', root.id);
    expect(reply.status).toBe(400);
  });

  it('hides an approved reply while its parent is pending', async () => {
    mf = await spawnWorker();
    auth = await login(mf);
    const root = await postComment(mf, 'Root', 'root');
    await approve(mf, auth.cookie, auth.csrf, root.id!);
    const reply = await postComment(mf, 'Child', 'reply', '/blog/x', root.id);
    expect(reply.status).toBe(200);
    await approve(mf, auth.cookie, auth.csrf, reply.id!);

    // Unapprove the PARENT after the reply was approved: the thread must hide.
    const unappr = await mf.dispatchFetch(`${BASE}/api/admin/comments/${root.id}`, {
      method: 'PATCH',
      headers: { cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'pending' }),
    });
    expect(unappr.status).toBe(200);

    const comments = await listPublic(mf);
    expect(comments).toHaveLength(0); // parent pending → thread hidden
  });

  it('keeps an approved reply when its parent is deleted (widget shows placeholder)', async () => {
    mf = await spawnWorker();
    auth = await login(mf);
    const root = await postComment(mf, 'Root', 'root');
    await approve(mf, auth.cookie, auth.csrf, root.id!);
    const reply = await postComment(mf, 'Child', 'reply', '/blog/x', root.id);
    await approve(mf, auth.cookie, auth.csrf, reply.id!);

    await delComment(mf, auth.cookie, auth.csrf, root.id!);

    const comments = await listPublic(mf);
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe(reply.id);
    expect(comments[0].parent_id).toBe(root.id); // client marks it parentMissing
  });

  it('surfaces the parent nickname in the admin queue', async () => {
    mf = await spawnWorker();
    auth = await login(mf);
    const root = await postComment(mf, 'Alice', 'root');
    await approve(mf, auth.cookie, auth.csrf, root.id!);
    const reply = await postComment(mf, 'Bob', 'reply', '/blog/x', root.id);

    const res = await mf.dispatchFetch(`${BASE}/api/admin/comments?status=pending`, {
      headers: { cookie: auth.cookie },
    });
    const data = (await res.json()) as {
      comments: Array<{ id: string; parent_id: string; parent_nickname: string }>;
    };
    const row = data.comments.find((c) => c.id === reply.id);
    expect(row).toBeTruthy();
    expect(row!.parent_id).toBe(root.id);
    expect(row!.parent_nickname).toBe('Alice');
  });

  it('the owner can reply from the admin: reply is approved, marked is_owner and public', async () => {
    mf = await spawnWorker();
    auth = await login(mf);
    const root = await postComment(mf, 'Alice', 'root');
    await approve(mf, auth.cookie, auth.csrf, root.id!);

    // No CSRF → 403.
    const noCsrf = await mf.dispatchFetch(`${BASE}/api/admin/comments/${root.id}/reply`, {
      method: 'POST',
      headers: { cookie: auth.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hi!' }),
    });
    expect(noCsrf.status).toBe(403);

    const res = await mf.dispatchFetch(`${BASE}/api/admin/comments/${root.id}/reply`, {
      method: 'POST',
      headers: { cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Grazie per il commento!' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      comment: { id: string; is_owner: number; status: string; nickname: string; parent_id: string };
    };
    expect(created.comment.is_owner).toBe(1);
    expect(created.comment.status).toBe('approved');
    expect(created.comment.nickname).toBe('Site owner');
    expect(created.comment.parent_id).toBe(root.id);

    // Public thread: the owner reply appears immediately (already approved).
    const comments = await listPublic(mf);
    const ownerReply = comments.find((c) => c.id === created.comment.id);
    expect(ownerReply).toBeTruthy();
    expect((ownerReply as unknown as { is_owner: number }).is_owner).toBe(1);
  });
});
