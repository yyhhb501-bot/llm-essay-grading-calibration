import { authJson } from './auth.mjs';

export async function servePracticePaper(request, { auth, db }) {
  if (request.method !== 'GET') return authJson({ error: '试卷读取只接受 GET。' }, 405);
  const access = await auth.authorize(request, { native: true, readOnly: true });
  if (access.response) return access.response;
  const match = /^\/api\/mp\/papers\/(source_[a-zA-Z0-9_]+)$/.exec(new URL(request.url).pathname);
  if (!match) return authJson({ error: '试卷地址不正确。' }, 404);
  try {
    const row = await db.prepare('SELECT body FROM practice_papers WHERE id=?1').bind(match[1]).first();
    if (!row) return authJson({ error: '这套试卷尚未导入。' }, 404);
    return new Response(row.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (_) { return authJson({ error: '试卷库暂不可用，请稍后重试。' }, 503); }
}
