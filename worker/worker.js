/**
 * worker/worker.js —— Cloudflare Worker：静态资源 + /api/chat 转发（方案-网站.md §1 / §5）
 *
 * 一个进程干两件事：
 *   1. 静态资源：site/ 目录由 [assets] 绑定到 env.ASSETS，请求交给 env.ASSETS.fetch；
 *   2. POST /api/chat：校验访问口令 → 按模式选密钥 → 调智谱（OpenAI 兼容）→ SSE 原样透传。
 *
 * /api/chat 契约（与 site-server.js 完全一致）：
 *   - 请求头：Content-Type: application/json、X-Access-Code: <访问口令>
 *   - 请求体：{ messages, model?, stream?, apiKey?, baseURL?, vision?, ping?,
 *              temperature?, thinking?, max_tokens? }
 *     · 服务端模式（默认）：不传 apiKey/baseURL，用环境变量 ZHIPU_API_KEY，
 *       默认 baseURL=https://open.bigmodel.cn/api/paas/v4，默认 model=glm-4-flash；
 *     · 自带 Key 模式：请求体带 apiKey/baseURL 时纯转发，Worker 不存储；
 *     · temperature / thinking / max_tokens 原样透传给上游（未传时用本地默认），
 *       共识锚点判定等窄任务靠它拿到低温、关思考的确定性输出。
 *   - 非 200 时把状态码与上游错误转成中文 JSON 返回：
 *     401→密钥无效、403→额度或权限、429→限流、口令错→「访问口令不正确」。
 *
 * 环境变量（用 wrangler secret put 配置）：
 *   ACCESS_CODE    访问口令；不设则不做口令校验（仅建议本地调试时这么用）
 *   ZHIPU_API_KEY  服务端模式的智谱密钥
 */

import { createAuth } from '../server/auth.mjs';
import { servePracticePaper } from '../server/paper-library.mjs';
import { adminOverview } from '../server/admin.mjs';

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const auth = createAuth({
      db: env && env.AUTH_DB,
      getInviteCode: () => (env && (env.REGISTER_INVITE_CODE || env.ACCESS_CODE)) || ''
    });
    if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/acct/') || url.pathname.startsWith('/api/mp/auth/')) {
      return auth.handle(request, { ip: request.headers.get('CF-Connecting-IP') || 'unknown', native: url.pathname.startsWith('/api/mp/auth/') });
    }

    if (url.pathname.startsWith('/api/mp/papers/')) {
      return servePracticePaper(request, { auth, db: env && env.AUTH_DB });
    }
    if (url.pathname === '/api/admin/overview') return adminOverview(request, { auth, db: env && env.AUTH_DB });

    // ---- 部署验证 ----
    if (url.pathname === '/api/health') {
      const openCodeReady = !!(env && env.OPENCODE_BRIDGE_URL && env.OPENCODE_BRIDGE_TOKEN);
      const zhipuReady = !!(env && env.ZHIPU_API_KEY);
      return json({
        ok: true,
        sharedReady: openCodeReady || zhipuReady,
        officialModel: openCodeReady ? 'OpenCode Go · DeepSeek V4.1 Flash' : 'GLM-5.3-Flash',
        sharedProvider: openCodeReady ? 'opencode-go' : (zhipuReady ? 'zhipu' : ''),
        authRequired: true,
        authReady: !!(env && env.AUTH_DB),
        registrationReady: auth.registrationReady()
      });
    }

    // ---- 模型转发 ----
    if (url.pathname === '/api/chat' || url.pathname === '/api/mp/chat') {
      if (request.method !== 'POST') {
        return json({ error: '请求方法不对，/api/chat 只接受 POST。' }, 405);
      }
      const authorization = await auth.authorize(request, { native: url.pathname === '/api/mp/chat' });
      if (authorization.response) return authorization.response;
      return handleChat(request, env);
    }

    // ---- 其余路径：静态资源 ----
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('静态资源未绑定：请在 wrangler.toml 里配置 [assets]。', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};

/** 组装 JSON 响应（中文内容，统一 UTF-8 与禁缓存） */
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * 上游非 200 → 中文错误
 * @param {number} status 上游状态码
 * @param {string} serverMsg 从上游响应体里抠出的说明
 * @returns {string}
 */
function describeUpstreamError(status, serverMsg) {
  let text;
  if (status === 401) {
    text = '密钥无效或已过期（HTTP 401），请检查 ZHIPU_API_KEY 或自带模式里的 API Key。';
  } else if (status === 403) {
    text = '访问被拒绝（HTTP 403），可能是额度不足或该模型无权限。';
  } else if (status === 429) {
    text = '请求过于频繁或额度已用尽（HTTP 429），请稍后重试或更换模型。';
  } else if (status === 404) {
    text = '接口地址不存在（HTTP 404），请检查 baseURL 是否填到 /v1 一级。';
  } else if (status >= 400 && status < 500) {
    text = '请求被拒绝（HTTP ' + status + '），请检查地址、密钥与模型名是否正确。';
  } else {
    text = '服务异常（HTTP ' + status + '），请稍后重试。';
  }
  if (serverMsg) text += ' 厂商提示：' + serverMsg;
  return text;
}

/** 从上游错误体里尽力抠出厂商原话 */
function pickServerMessage(text) {
  const raw = text == null ? '' : String(text);
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.error) {
      const e = obj.error;
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') return e.message || e.code || '';
    }
    if (obj && typeof obj === 'object') return '';
  } catch (e) {
    // 不是 JSON，原样截一段
  }
  return raw.slice(0, 200);
}

/**
 * POST /api/chat 主流程
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @returns {Promise<Response>}
 */
async function handleChat(request, env) {
  // Account session and same-origin checks have already passed in fetch().
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是合法 JSON。' }, 400);
  }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    return json({ error: '请求体里没有 messages，请刷新页面重试。' }, 400);
  }

  // 3. 选模式：自带 Key 纯转发，服务端模式用环境变量密钥
  const ownKey = String(body.apiKey || '').trim();
  const bridgeUrl = String((env && env.OPENCODE_BRIDGE_URL) || '').trim();
  const bridgeToken = String((env && env.OPENCODE_BRIDGE_TOKEN) || '').trim();
  if (!ownKey && bridgeUrl) {
    if (!bridgeToken) return json({ error: 'OpenCode 本机桥接尚未配置访问密钥。' }, 500);
    let target;
    try { target = new URL(bridgeUrl); } catch (e) { return json({ error: 'OpenCode 桥接地址配置无效。' }, 500); }
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) {
      return json({ error: 'OpenCode 桥接地址必须是 HTTPS 且不能包含账号信息或查询参数。' }, 500);
    }
    target.pathname = target.pathname.replace(/\/+$/, '') + '/api/chat';
    let bridge;
    try {
      bridge = await fetch(target.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + bridgeToken
        },
        body: JSON.stringify({
          messages: body.messages,
          stream: body.stream !== false,
          ping: !!body.ping,
          vision: !!body.vision
        })
      });
    } catch (e) {
      return json({ error: '无法连接站主电脑上的 OpenCode，请确认本机服务和 Cloudflare Tunnel 正在运行。' }, 502);
    }
    if (!bridge.ok) {
      const text = await bridge.text().catch(() => '');
      return json({ error: pickServerMessage(text) || 'OpenCode 桥接请求失败。' }, bridge.status >= 400 && bridge.status < 600 ? bridge.status : 502);
    }
    const contentType = bridge.headers.get('Content-Type') || 'application/json; charset=utf-8';
    return new Response(bridge.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': contentType.indexOf('text/event-stream') >= 0 ? 'no-cache, no-transform' : 'no-store',
        ...(contentType.indexOf('text/event-stream') >= 0 ? { 'X-Accel-Buffering': 'no' } : {})
      }
    });
  }
  let apiKey = ownKey;
  let baseURL;
  if (apiKey) {
    baseURL = String(body.baseURL || '').trim() || 'https://open.bigmodel.cn/api/paas/v4';
  } else {
    apiKey = String((env && env.ZHIPU_API_KEY) || '').trim();
    baseURL = String((env && env.ZHIPU_BASE_URL) || 'https://open.bigmodel.cn/api/paas/v4').trim();
  }
  if (!apiKey) {
    return json({ error: '服务端还没有配置模型密钥：请站主执行 wrangler secret put ZHIPU_API_KEY，或改用自带 Key 模式。' }, 500);
  }
  baseURL = baseURL.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseURL)) {
    return json({ error: '模型地址格式不对，应以 https:// 开头。' }, 400);
  }

  const defaultModel = body.vision ? 'glm-4v-flash' : 'glm-5.3-flash';
  const model = String(body.model || '').trim() || defaultModel;
  const stream = body.stream !== false;

  const upstreamBody = {
    model: model,
    messages: body.messages,
    stream: stream,
    // 客户端显式传的参数优先（共识锚点判定要 thinking:disabled + 低温度），未传时维持原有默认
    temperature: body.temperature === undefined ? 0.3 : body.temperature
  };
  if (model === 'glm-5.3-flash') {
    upstreamBody.thinking = body.thinking === undefined ? { type: 'enabled' } : body.thinking;
    if (body.temperature === undefined) upstreamBody.temperature = 1;
  }
  if (body.ping) upstreamBody.max_tokens = 8; // 连通性测试：限制输出长度
  else if (Number(body.max_tokens) > 0) upstreamBody.max_tokens = Number(body.max_tokens);
  else upstreamBody.max_tokens = 16384; // 报告+思考需要足量输出预算，防止长报告被截断

  // 4. 请求上游
  let upstream;
  try {
    upstream = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(upstreamBody)
    });
  } catch (e) {
    return json({ error: '连不上模型厂商：' + ((e && e.message) || '网络异常') + '，请稍后重试。' }, 502);
  }

  // 5. 非 200：转成中文 JSON 返回
  if (upstream.status !== 200) {
    const text = await upstream.text().catch(() => '');
    const serverMsg = pickServerMessage(text);
    let error = describeUpstreamError(upstream.status, serverMsg);
    // 视觉请求的专门提示：上游说认不出图片时给出可操作建议
    if (upstream.status === 400 && body.vision && /image|content|vision|图片|视觉/i.test(serverMsg)) {
      error = '当前模型可能不支持图片输入，请到设置页配置视觉模型。 厂商提示：' + serverMsg;
    }
    return json({ error: error }, upstream.status);
  }

  // 6. 成功：流式原样透传（SSE 分块流），非流式原样回 JSON
  if (stream) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  }
  const text = await upstream.text();
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
