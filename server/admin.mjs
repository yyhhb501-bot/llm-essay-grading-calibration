import { authJson } from './auth.mjs';

export async function adminOverview(request, { auth, db }) {
  if (request.method !== 'GET') return authJson({ error: '当前管理概况只接受 GET。' }, 405);
  const access = await auth.authorizeAdmin(request, { readOnly: true });
  if (access.response) return access.response;
  try {
    const accounts = await db.prepare('SELECT COUNT(*) AS count FROM auth_users').first();
    const papers = await db.prepare('SELECT COUNT(*) AS count FROM practice_papers').first();
    return authJson({ ok: true, user: access.user, counts: { accounts: accounts.count, papers: papers.count } });
  } catch (_) { return authJson({ error: '暂时无法读取站点概况。' }, 503); }
}
