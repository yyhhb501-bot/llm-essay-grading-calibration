/**
 * site/js/api.js —— 模型 API 接入层（浏览器版，方案-网站.md §3 / §5）
 *
 * 与小程序 utils/api.js 语义一一对应，只是把 wx.request 换成 fetch + ReadableStream：
 *   1. PRESETS：六家供应商预设，选中后带出 baseURL、模型与视觉模型候选；
 *   2. chatStream：把 messages POST 到同源 /api/chat，逐块解析 SSE（行缓冲 → data: → [DONE]），
 *      少数服务不真正分块时按整段 JSON 降级解析；
 *   3. 出错后自动降级一次非流式请求（stream:false），成功后补一次 onDelta(全文) + onDone(全文)；
 *   4. transcribeSheet：拍照识别的视觉消息结构（image_url + OCR 指令）与 mimeType 推断；
 *   5. testConnection：非流式连通性探测；
 *   6. chatOnce：一次性非流式对话（Promise），供共识锚点判定等窄任务使用，可显式指定
 *      temperature / thinking / max_tokens，转发层按原样透传；
 *   7. 错误中文化：HTTP 状态码与厂商提示都转成中文，403/429/404 等按小程序版同一套措辞。
 *
 * 关键约定（与小程序版一致）：handlers 只有 onDelta / onDone / onError 三个回调，均可选；
 * 出错时先回调 onError(中文错误)，随后自动降级重试一次；若降级成功，
 * 会再依次回调 onDelta(全文) 与 onDone(全文)，页面可据此把错误卡撤下继续显示内容。
 *
 * 返回值是一个 { abort() } 任务对象（对应小程序的 RequestTask）。
 */
(function (root) {
  'use strict';

  /** 同源转发接口（Cloudflare Worker 与 site-server.js 提供同一份契约） */
  var CHAT_ENDPOINT = '/api/chat';

  /** 服务端模式下的默认模型（方案 §5） */
  var SERVER_DEFAULT_MODEL = '共享模型';

  /**
   * 六个供应商预设，baseURL 与模型清单与小程序版 utils/api.js 的 PRESETS 完全一致；
   * visionModels 为视觉模型候选（拍照识别用），空数组表示该预设没有视觉模型。
   */
  var PRESETS = [
    {
      id: 'zhipu',
      name: '智谱开放平台',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-5.3-flash', 'glm-4.6', 'glm-4.5-air', 'glm-4-flash'],
      visionModels: ['glm-5.3-flash', 'glm-4v-flash', 'glm-4v-plus'],
      doc: '支持 GLM-5.3-Flash 文本与图片输入，使用智谱官方 API Key，费用以账户计费规则为准。',
      applyUrl: 'https://open.bigmodel.cn',
      directOk: true,
      tagline: 'GLM-5.3-Flash 支持作文批改和图片识别；选择预设后填入自己的智谱 API Key。'
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      visionModels: [],
      doc: 'deepseek-chat 速度快，deepseek-reasoner 为深度思考模型，批改长文建议先用 chat。',
      applyUrl: 'https://platform.deepseek.com',
      directOk: true,
      tagline: '性价比高、响应快，手机直连可用；无视觉模型，拍照识别需另配支持图片的厂商。'
    },
    {
      id: 'moonshot',
      name: '月之暗面 Kimi',
      baseURL: 'https://api.moonshot.cn/v1',
      models: ['moonshot-v1-8k', 'kimi-k2-0905-preview'],
      visionModels: ['moonshot-v1-8k-vision-preview'],
      doc: '长文材料建议选 kimi 系列，8k 上下文足够单篇申论材料。',
      applyUrl: 'https://platform.moonshot.cn',
      directOk: false,
      tagline: '长文材料友好。Kimi 不允许浏览器直连，单文件本地打开时需走网址版转发模式。'
    },
    {
      id: 'qwen',
      name: '阿里通义千问',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-plus', 'qwen-max'],
      visionModels: ['qwen-vl-plus', 'qwen-vl-max'],
      doc: '兼容模式与 OpenAI 接口一致，直接填 DashScope 的 API Key。',
      applyUrl: 'https://bailian.console.aliyun.com',
      directOk: true,
      tagline: '有免费额度，手机直连可用；视觉 qwen-vl 系列支持拍照识别。'
    },
    {
      id: 'openai',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini', 'gpt-4o'],
      visionModels: ['gpt-4o', 'gpt-4o-mini'],
      doc: 'gpt-4o-mini 性价比高，国内网络环境需自行保证可直连。',
      applyUrl: 'https://platform.openai.com',
      directOk: false,
      tagline: '国内网络通常无法直连，需要自备中转地址（可用「自定义」预设填中转）。'
    },
    {
      id: 'custom',
      name: '自定义',
      baseURL: '',
      models: [],
      visionModels: [],
      doc: '任何 OpenAI 兼容的自建或中转服务，地址请填到 /v1 一级，不含 /chat/completions。',
      applyUrl: '',
      directOk: true,
      tagline: '任何 OpenAI 兼容服务（含中转）：地址填到 /v1 一级，模型名手输。'
    }
  ];

  /**
   * 拍照识别的转录指令（与小程序版一致）：只转录不批改，避免模型顺手给建议污染作答框。
   */
  var OCR_INSTRUCTION =
    '你是申论答题卡转录助手：把图片中的手写作答逐字转录为纯文本。' +
    '要求：保留原有分段与序号；不要解释、不要批改、不要添加任何多余文字；' +
    '无法辨认的字用 □ 占位；若整图无可识别文字，只输出（未识别到文字）。';

  /** OCR 指令里约定的「整图没有可识别文字」哨兵 */
  var OCR_EMPTY_MARK = '（未识别到文字）';

  // ---- 配置 ----

  /** 按 id 取预设 */
  function getPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return null;
  }

  /**
   * 配置清洗：去空白、去末尾斜杠、补默认值。
   * mode='server' 时 apiKey/baseURL 可以为空（走服务端密钥）；'selfkey' 时必须有。
   */
  function normalizeConfig(cfg) {
    var input = cfg || {};
    var mode = input.mode === 'selfkey' ? 'selfkey' : 'server';
    var presetId = String(input.presetId == null ? '' : input.presetId).trim();
    if (!getPreset(presetId)) presetId = 'zhipu'; // 默认落到第一家预设

    var baseURL = String(input.baseURL == null ? '' : input.baseURL).trim();
    if (!baseURL) {
      var preset = getPreset(presetId);
      if (preset && preset.baseURL) baseURL = preset.baseURL;
    }
    baseURL = baseURL.replace(/\/+$/, '');

    return {
      mode: mode,
      accessCode: String(input.accessCode == null ? '' : input.accessCode).trim(),
      presetId: presetId,
      baseURL: baseURL,
      apiKey: String(input.apiKey == null ? '' : input.apiKey).trim(),
      model: String(input.model == null ? '' : input.model).trim(),
      visionModel: String(input.visionModel == null ? '' : input.visionModel).trim()
    };
  }

  /** 校验配置，返回中文提示或空串 */
  function validateConfig(conf) {
    if (!isLocalFile() && (!root.Auth || !root.Auth.isAuthenticated())) return '请先登录账号。';
    if (conf.mode === 'server') {
      return '';
    }
    if (!conf.baseURL) return '还没有填写模型地址，请到设置页选择供应商或填写 baseURL。';
    if (!/^https?:\/\//i.test(conf.baseURL)) return '模型地址格式不对，应以 https:// 开头。';
    if (!conf.apiKey) return '还没有填写 API Key，请到设置页填写。';
    if (!conf.model) return '还没有选择模型，请到设置页选择或手输模型名。';
    return '';
  }

  /** 组装转发请求体：自带 Key 模式才带 apiKey/baseURL，服务端模式一律不带 */
  function buildPayload(conf, messages, model, stream) {
    var payload = { messages: messages || [], model: model || '', stream: !!stream };
    if (conf.mode === 'selfkey') {
      payload.apiKey = conf.apiKey;
      payload.baseURL = conf.baseURL;
    }
    return payload;
  }

  // ---- 错误中文化 ----

  /** 从上游/转发层返回的错误说明里尽力抠出厂商原话 */
  function pickServerMessage(text) {
    var raw = text == null ? '' : String(text);
    if (!raw) return '';
    try {
      var obj = JSON.parse(raw);
      if (obj && obj.error) {
        var e = obj.error;
        if (typeof e === 'string') return e;
        if (e && typeof e === 'object') return e.message || e.code || '';
      }
      if (obj && typeof obj === 'object') return ''; // 是 JSON 但没有 error 字段
    } catch (e) {
      // 不是 JSON，原样截一段
    }
    return raw.slice(0, 120);
  }

  /** HTTP 状态码 → 中文错误（措辞与小程序版一致，只是把「模型设置」换成「设置页」） */
  function describeHttpError(statusCode, serverMsg) {
    var text;
    if (statusCode === 401) {
      text = '密钥无效或已过期（HTTP 401），请到设置页检查 API Key 或访问口令。';
    } else if (statusCode === 403) {
      text = '访问被拒绝（HTTP 403），可能是额度不足或该模型无权限，请检查账户余额与模型权限。';
    } else if (statusCode === 429) {
      text = '请求过于频繁或额度已用尽（HTTP 429），请稍后重试或更换模型。';
    } else if (statusCode === 404) {
      text = '接口地址不存在（HTTP 404），请检查 baseURL 是否填到 /v1 一级。';
    } else if (statusCode >= 400 && statusCode < 500) {
      text = '请求被拒绝（HTTP ' + statusCode + '），请检查地址、密钥与模型名是否正确。';
    } else {
      text = '服务异常（HTTP ' + statusCode + '），请稍后重试。';
    }
    if (serverMsg) text += ' 厂商提示：' + serverMsg;
    return text;
  }

  /** 网络层异常 → 中文错误 */
  function describeFailError(err, timeoutSeconds) {
    var name = (err && err.name) || '';
    var raw = String((err && err.message) || '');
    if (name === 'AbortError' || /abort/i.test(raw)) return '请求已被中止。';
    if (/timeout|timed out|超时/i.test(raw)) {
      var sec = Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : 120;
      return '请求超时（' + sec + ' 秒内没有返回内容），请检查网络或改用响应更快的模型。';
    }
    if (/failed to fetch|networkerror|load failed/i.test(raw)) {
      return '网络请求失败：连不上转发服务器，请检查网络连接后重试。';
    }
    return '网络请求失败：' + (raw || '未知错误');
  }

  /** 视觉请求的 HTTP 错误措辞：提到图片/内容/视觉时给专门提示 */
  function describeVisionHttpError(statusCode, serverMsg) {
    if (statusCode === 400 && /image|content|vision|图片|视觉/i.test(String(serverMsg || ''))) {
      var text = '当前模型可能不支持图片输入，请到设置页配置视觉模型。';
      if (serverMsg) text += ' 厂商提示：' + serverMsg;
      return text;
    }
    return describeHttpError(statusCode, serverMsg);
  }

  /** 安全调用 handlers 上的可选回调 */
  function safeCall(handlers, name, arg) {
    var h = handlers || {};
    if (typeof h[name] === 'function') {
      try {
        h[name](arg);
      } catch (e) {
        if (root.console) console.error('[api] 回调 ' + name + ' 抛出异常：', e);
      }
    }
  }

  /** 从一次性（非流式）响应体里取 answer 文本 */
  function readPlainAnswer(raw) {
    try {
      var obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      var text = obj && obj.choices && obj.choices[0] &&
        obj.choices[0].message && obj.choices[0].message.content;
      if (typeof text === 'string') return text;
    } catch (e) {
      // 不是标准结构，交给上层处理
    }
    return null;
  }

  // 请求地址由流式、非流式和测试连接共同使用，必须放在模块作用域。
  // glm-5.3-flash 默认开思考、温度 1；调用方显式传了 thinking/temperature 时以显式值为准
  // （共识锚点判定等窄任务需要 thinking:disabled + 低温度）。
  function serializePayload(payload) {
    if (payload.model === 'glm-5.3-flash') {
      if (payload.thinking === undefined) payload.thinking = { type: 'enabled' };
      if (payload.temperature === undefined) payload.temperature = 1;
    }
    return JSON.stringify(payload);
  }

  function isLocalFile() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  function getEndpointInfo(conf, stream, ping) {
    if (isLocalFile() && conf.mode === 'selfkey') {
      var url = (conf.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
      var headers = { 'Content-Type': 'application/json' };
      if (conf.apiKey) headers['Authorization'] = 'Bearer ' + conf.apiKey;
      return { url: url, headers: headers, isDirect: true };
    }
    var headersDefault = { 'Content-Type': 'application/json' };
    return { url: CHAT_ENDPOINT, headers: headersDefault, isDirect: false };
  }

  function accountError(res, text) {
    if (isLocalFile() || res.status !== 401) return false;
    try {
      var body = JSON.parse(text);
      if (body.code === 'AUTH_REQUIRED' || body.code === 'SESSION_CHANGED') {
        if (root.Auth) root.Auth.requireLogin('登录已过期，请重新登录。');
        return true;
      }
    } catch (_) {}
    return false; // A model provider's 401 is a model-key error, not a logged-out account.
  }

  // ---- 流式内核 ----

  /**
   * 流式请求的公共内核（chatStream 与 transcribeSheet 共用）。
   * 与小程序版的 runStream 语义一致：行缓冲跨块缓存、只认 data 行、忽略心跳注释、
   * 收到 [DONE] 收尾、出错先 onError 再降级一次非流式。
   *
   * @param {Object} params
   *   conf      normalizeConfig 之后的配置
   *   messages  OpenAI 格式消息数组
   *   model     本次请求使用的模型名（空串表示服务端用默认值）
   *   handlers  {onDelta, onDone, onError}
   *   vision    是否为视觉请求（影响 HTTP 错误措辞）
   *   extra     额外写进请求体的字段（如 vision 标记）
   * @returns {{abort:Function}}
   */
  function runStream(params) {
    var conf = params.conf;
    var messages = params.messages || [];
    var handlers = params.handlers || {};
    var describeHttp = params.vision ? describeVisionHttpError : describeHttpError;

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var lineBuffer = ''; // 分块可能切断一行，需要跨块缓存
    var fullText = '';
    var settled = false; // 保证 onDone 只回调一次
    var fallbackTried = false;
    var canceled = false;

    function finish(text) {
      if (settled) return;
      settled = true;
      safeCall(handlers, 'onDone', text);
    }

    function fail(message) {
      if (settled) return;
      safeCall(handlers, 'onError', message);
      if (fallbackTried || canceled) return; // 只降级一次；用户已中止就不再烧请求
      fallbackTried = true;
      nonStreamCall(conf, messages, params.model, function (text) {
        if (canceled || settled) return;
        // 降级成功：一次性吐出全文，页面可撤下错误卡
        fullText = text;
        if (typeof handlers.onReplace === 'function') {
          safeCall(handlers, 'onReplace', text);
        } else {
          safeCall(handlers, 'onDelta', text);
        }
        finish(text);
      }, function (fallbackMsg) {
        // 降级也失败：不重复回调 onError，避免页面出现两张错误卡
        if (root.console) console.error('[api] 降级请求同样失败：' + fallbackMsg);
      }, params.vision);
    }

    /** 处理一行 SSE（或整段 JSON） */
    function handleLine(line) {
      var trimmed = String(line).replace(/\r$/, '');
      if (!trimmed) return;
      if (trimmed.charAt(0) === ':') return; // SSE 注释行（心跳）
      var payload;
      if (trimmed.indexOf('data:') === 0) {
        payload = trimmed.slice(5).trim();
      } else if (trimmed.charAt(0) === '{') {
        payload = trimmed; // 少数服务不真正分块，直接吐整段 JSON
      } else {
        return; // 只认 data 行
      }
      if (!payload) return;
      if (payload === '[DONE]') {
        finish(fullText);
        return;
      }
      var obj;
      try {
        obj = JSON.parse(payload);
      } catch (e) {
        return; // 半行或厂商私有字段，忽略
      }
      if (obj && obj.error) {
        var msg = typeof obj.error === 'string' ? obj.error : (obj.error.message || '');
        fail('模型返回错误：' + (msg || '未知错误'));
        return;
      }
      var choices = obj && obj.choices;
      if (!choices || !choices.length) return;
      var first = choices[0] || {};
      var delta = first.delta && first.delta.content;
      // 少数服务不真正分块，把整段一次性 JSON 当普通响应吐回来（没有 [DONE]、
      // 也没有 delta，只有 message.content）——与小程序的非分块降级同一语义
      if (typeof delta !== 'string' || !delta) {
        var whole = first.message && first.message.content;
        if (typeof whole === 'string' && whole) {
          fullText += whole;
          safeCall(handlers, 'onDelta', whole);
        }
        return;
      }
      fullText += delta;
      safeCall(handlers, 'onDelta', delta);
    }

    /** 把一整块文本喂进行缓冲，处理完所有完整行 */
    function feed(text) {
      if (!text) return;
      lineBuffer += text;
      var idx;
      while ((idx = lineBuffer.indexOf('\n')) !== -1) {
        var line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        handleLine(line);
        if (settled) return;
      }
    }

    /** 流式响应体解析完但没收到 [DONE] 时的收尾 */
    function flushTail() {
      if (lineBuffer.trim()) handleLine(lineBuffer);
      lineBuffer = '';
      finish(fullText);
    }

    var ep = getEndpointInfo(conf, true, false);
    var payload;
    if (ep.isDirect) {
      payload = {
        model: params.model || conf.model,
        messages: messages || [],
        stream: true
      };
    } else {
      payload = buildPayload(conf, messages, params.model, true);
    }
    if (params.extra) {
      for (var k in params.extra) {
        if (Object.prototype.hasOwnProperty.call(params.extra, k)) payload[k] = params.extra[k];
      }
    }

    root.fetch(ep.url, {
      method: 'POST',
      credentials: ep.isDirect ? 'omit' : 'same-origin',
      headers: ep.headers,
      body: serializePayload(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (res.status !== 200) {
        return res.text().then(function (text) {
          if (accountError(res, text)) { canceled = true; settled = true; return; }
          var serverMsg = pickServerMessage(text);
          // 转发层已经给的是中文（如「访问口令不正确」「密钥无效」），有原话就直接用
          fail(serverMsg && /[一-龥]/.test(serverMsg) ? serverMsg : describeHttp(res.status, serverMsg));
        });
      }
      // 降级路径一：浏览器/服务端没有 ReadableStream（如某些老浏览器），一次性读完
      if (!res.body || typeof res.body.getReader !== 'function') {
        return res.text().then(function (text) {
          var plain = readPlainAnswer(text);
          if (plain !== null) {
            safeCall(handlers, 'onDelta', plain);
            finish(plain);
            return;
          }
          feed(text);
          flushTail();
        });
      }
      // 正常路径：逐块读 SSE
      var reader = res.body.getReader();
      var decoder = (typeof TextDecoder === 'function') ? new TextDecoder('utf-8') : null;
      function pump() {
        return reader.read().then(function (chunk) {
          if (settled) return;
          if (chunk.done) {
            if (decoder) feed(decoder.decode());
            flushTail();
            return;
          }
          var bytes = chunk.value;
          var text = null;
          if (decoder) {
            text = decoder.decode(bytes, { stream: true });
          } else if (typeof bytes === 'string') {
            text = bytes;
          }
          if (text) feed(text);
          if (settled) {
            try {
              reader.cancel();
            } catch (e) { /* 已关闭，忽略 */ }
            return;
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (canceled) {
        // 页面主动中止：只回报一次，且不再发起降级请求
        if (settled) return;
        settled = true;
        safeCall(handlers, 'onError', describeFailError(err, 120));
        return;
      }
      fail(describeFailError(err, 120));
    });

    return {
      abort: function () {
        canceled = true;
        if (controller) {
          try {
            controller.abort();
          } catch (e) { /* 忽略 */ }
        }
      }
    };
  }

  /** 请求头：两种模式都要带访问口令 */
  function buildHeaders(conf) {
    var headers = { 'Content-Type': 'application/json' };
    return headers;
  }

  /**
   * 非流式调用（降级通道与连通性测试共用）
   * @param {Function} onSuccess 接收 answer 文本
   * @param {Function} onFail    接收中文错误
   * @param {boolean} [vision]   是否视觉请求（影响错误措辞）
   * @param {Object}  [extras]   额外写进请求体的字段（temperature / thinking / max_tokens 等）
   */
  function nonStreamCall(conf, messages, model, onSuccess, onFail, vision, extras) {
    if (!isLocalFile() && (!root.Auth || !root.Auth.isAuthenticated())) { onFail('请先登录账号。'); return Promise.resolve(); }
    var describeHttp = vision ? describeVisionHttpError : describeHttpError;
    var ep = getEndpointInfo(conf, false, false);
    var payload;
    if (ep.isDirect) {
      payload = {
        model: model || conf.model,
        messages: messages || [],
        stream: false
      };
    } else {
      payload = buildPayload(conf, messages, model, false);
    }
    if (extras) {
      for (var k in extras) {
        if (Object.prototype.hasOwnProperty.call(extras, k)) payload[k] = extras[k];
      }
    }
    return root.fetch(ep.url, {
      method: 'POST',
      credentials: ep.isDirect ? 'omit' : 'same-origin',
      headers: ep.headers,
      body: serializePayload(payload)
    }).then(function (res) {
      return res.text().then(function (text) {
        if (res.status !== 200) {
          if (accountError(res, text)) return;
          var serverMsg = pickServerMessage(text);
          onFail(serverMsg && /[一-龥]/.test(serverMsg) ? serverMsg : describeHttp(res.status, serverMsg));
          return;
        }
        var answer = readPlainAnswer(text);
        if (answer === null) {
          onFail('模型返回的内容无法解析，请稍后重试。');
          return;
        }
        onSuccess(answer);
      });
    }).catch(function (err) {
      onFail(describeFailError(err, 120));
    });
  }

  // ---- 对外接口 ----

  /**
   * 流式对话
   * @param {Object} cfg 接入配置（store.getConfig() 的结构）
   * @param {Array}  messages OpenAI 格式的消息数组
   * @param {Object} handlers {onDelta,onDone,onError}
   * @returns {{abort:Function}} 任务对象
   */
  function chatStream(cfg, messages, handlers) {
    var conf = normalizeConfig(cfg);
    var bad = validateConfig(conf);
    if (bad) {
      // 配置不全时也给一次降级机会：让调用方走非流式，避免整页卡死
      safeCall(handlers, 'onError', bad);
      return null;
    }
    return runStream({
      conf: conf,
      messages: messages || [],
      model: conf.mode === 'server' ? (conf.model || '') : conf.model,
      handlers: handlers,
      vision: false
    });
  }

  /**
   * 拍照识别作答：把答题卡照片转录为纯文本。
   * 视觉消息结构与小程序的 transcribeSheet 完全一致：
   *   content: [{type:'image_url', image_url:{url:'data:<mime>;base64,<图片>'}}, {type:'text', text:OCR_INSTRUCTION}]
   *
   * @param {Object} cfg 接入配置
   * @param {string} imageBase64 图片 base64 内容（不带 data: 前缀）
   * @param {Object} handlers {onDelta,onDone,onError}
   * @param {string} [mimeType] 图片 MIME，默认 image/jpeg；调用方按文件名后缀推断
   * @returns {{abort:Function}|null}
   */
  function transcribeSheet(cfg, imageBase64, handlers, mimeType) {
    var conf = normalizeConfig(cfg);
    // 视觉模型优先，未配置时回退主模型（与服务端模式无关的本地选择）
    var model = conf.visionModel || conf.model;
    var bad = validateConfig(conf);
    if (bad) {
      safeCall(handlers, 'onError', bad);
      return null;
    }
    if (!imageBase64) {
      safeCall(handlers, 'onError', '没有读取到图片内容，请重新拍照。');
      return null;
    }
    var mime = String(mimeType || '').trim() || 'image/jpeg';

    var messages = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + imageBase64 } },
          { type: 'text', text: OCR_INSTRUCTION }
        ]
      }
    ];

    return runStream({
      conf: conf,
      messages: messages,
      model: conf.mode === 'server' ? model : model,
      handlers: handlers,
      vision: true,
      extra: { vision: true }
    });
  }

  /**
   * 按文件名后缀推断图片 MIME（png → image/png，其余按 jpeg 处理，与小程序版一致）
   * @param {string} fileName
   * @returns {string}
   */
  function guessMime(fileName) {
    return /\.png$/i.test(String(fileName || '')) ? 'image/png' : 'image/jpeg';
  }

  /** 该配置对应的上游是否认识 thinking 参数：智谱系与服务端模式才带，避免其他厂商 400 */
  function supportsThinking(conf) {
    return conf.mode === 'server' || conf.presetId === 'zhipu' || /bigmodel\.cn/i.test(conf.baseURL || '');
  }

  /**
   * 一次性非流式对话（Promise 版）。供共识锚点判定等窄任务使用：
   * 这类任务要的是确定性 JSON 输出，不需要流式展示。
   * @param {Object} cfg 接入配置（store.getConfig() 的结构）
   * @param {Array}  messages OpenAI 格式的消息数组
   * @param {Object} [opts] {temperature, thinking:'disabled'|'enabled', maxTokens}
   * @returns {Promise<string>} 模型 answer 文本；失败 reject(Error)，message 为中文错误
   */
  function chatOnce(cfg, messages, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var conf = normalizeConfig(cfg);
      var bad = validateConfig(conf);
      if (bad) {
        reject(new Error(bad));
        return;
      }
      var extras = {};
      if (opts.temperature !== undefined) extras.temperature = opts.temperature;
      if (Number(opts.maxTokens) > 0) extras.max_tokens = Number(opts.maxTokens);
      if (opts.thinking && supportsThinking(conf)) extras.thinking = { type: opts.thinking };
      nonStreamCall(conf, messages, conf.model, function (text) {
        resolve(text);
      }, function (msg) {
        reject(new Error(msg));
      }, false, extras);
    });
  }

  /**
   * 连通性测试：非流式 ping，只测主模型。
   * @returns {Promise<{ok:boolean,message:string,latencyMs:number}>}
   */
  function testConnection(cfg) {
    return new Promise(function (resolve) {
      var conf = normalizeConfig(cfg);
      var bad = validateConfig(conf);
      if (bad) {
        resolve({ ok: false, message: bad, latencyMs: 0 });
        return;
      }
      var started = Date.now();
      var done = false;
      function finish(ok, message) {
        if (done) return;
        done = true;
        resolve({ ok: ok, message: message, latencyMs: Date.now() - started });
      }
      var ep = getEndpointInfo(conf, false, true);
      var payload;
      if (ep.isDirect) {
        payload = {
          model: conf.model,
          messages: [{ role: 'user', content: '你好' }],
          stream: false,
          max_tokens: 8
        };
      } else {
        payload = buildPayload(conf, [{ role: 'user', content: '你好' }], conf.model, false);
        payload.ping = true; // 转发层据此限制输出长度（max_tokens 8）
      }

      root.fetch(ep.url, {
        method: 'POST',
        credentials: ep.isDirect ? 'omit' : 'same-origin',
        headers: ep.headers,
        body: serializePayload(payload)
      }).then(function (res) {
        return res.text().then(function (text) {
          if (res.status !== 200) {
            if (accountError(res, text)) { finish(false, '登录已过期，请重新登录。'); return; }
            var serverMsg = pickServerMessage(text);
            finish(false, serverMsg && /[一-龥]/.test(serverMsg) ? serverMsg : describeHttpError(res.status, serverMsg));
            return;
          }
          var answer = readPlainAnswer(text);
          if (answer === null) {
            finish(false, '模型返回的内容无法解析，请确认地址是否为 OpenAI 兼容格式。');
            return;
          }
          var returnedModel = '';
          try { returnedModel = String(JSON.parse(text).model || '').trim(); } catch (_) {}
          var name = conf.mode === 'server' ? (returnedModel || SERVER_DEFAULT_MODEL) : conf.model;
          finish(true, '连接成功，模型 ' + name + ' 可用。');
        });
      }).catch(function (err) {
        finish(false, describeFailError(err, 30));
      });
    });
  }

  root.Api = {
    PRESETS: PRESETS,
    CHAT_ENDPOINT: CHAT_ENDPOINT,
    SERVER_DEFAULT_MODEL: SERVER_DEFAULT_MODEL,
    OCR_INSTRUCTION: OCR_INSTRUCTION,
    OCR_EMPTY_MARK: OCR_EMPTY_MARK,
    getPreset: getPreset,
    normalizeConfig: normalizeConfig,
    chatStream: chatStream,
    chatOnce: chatOnce,
    transcribeSheet: transcribeSheet,
    guessMime: guessMime,
    testConnection: testConnection
  };
})(typeof window !== 'undefined' ? window : this);
