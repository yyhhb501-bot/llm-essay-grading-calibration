/**
 * utils/api.js —— 模型 API 接入层
 *
 * 职责（对应《方案.md》§6）：
 *   1. PRESETS：六家供应商预设，选中后自动带出 baseURL、模型列表与视觉模型列表；
 *   2. chatStream：OpenAI 兼容接口 /chat/completions 的流式请求
 *      （wx.request + enableChunked + onChunkReceived + utils/utf8.js 增量解码 + SSE 行解析）；
 *   3. transcribeSheet：拍照识别作答的视觉模型转录请求（方案 §4.5），复用同一套分块解析；
 *   4. 错误中文化，并在出错后自动降级一次非流式请求；
 *   5. testConnection：非流式连通性探测；
 *   6. normalizeConfig：配置项 trim 与默认值补全。
 *
 * 约束：零 npm 依赖、零云开发；分块是 ArrayBuffer，必须走 utils/utf8.js 的增量解码器。
 * 约定：chatStream / transcribeSheet 的 handlers 只有三个回调——onDelta / onDone / onError，均为可选。
 *   出错时先回调 onError(中文错误)，随后自动降级重试一次；若降级成功，
 *   会再依次回调 onDelta(全文) 与 onDone(全文)，页面可据此把错误卡撤下继续显示内容。
 */

/** 域名不合法的统一提示文案（方案 §6 明确要求） */
var modelRequest = require('./model-request.js');
var auth = require('./auth.js');
var DOMAIN_HINT =
  '请求域名不合法：请在微信公众平台配置对应的 request 合法域名；账号服务使用 https://shenlundawang.asia。';

/**
 * 六个供应商预设，baseURL 与模型清单严格照《方案.md》§6 表格；
 * visionModels 为方案 §4.5 表格里的视觉模型候选（拍照识别用），留空表示该预设没有视觉模型。
 */
var PRESETS = [
  {
    id: 'zhipu',
    name: '智谱开放平台',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3-flash', 'glm-4.6', 'glm-4.5-air', 'glm-4-flash'],
    visionModels: ['glm-5.3-flash', 'glm-4v-flash', 'glm-4v-plus'],
    doc: '支持 GLM-5.3-Flash 文本与图片输入，使用智谱官方 API Key，费用以账户计费规则为准。'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    visionModels: ['deepseek-flash'],
    doc: '官方接口 api.deepseek.com；默认使用 deepseek-flash，也可选择 deepseek-v4-pro 或填写你账户可用的模型名。'
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'kimi-k2-0905-preview'],
    visionModels: ['moonshot-v1-8k-vision-preview'],
    doc: '长文材料建议选 kimi 系列，8k 上下文足够单篇申论材料。'
  },
  {
    id: 'qwen',
    name: '阿里通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max'],
    visionModels: ['qwen-vl-plus', 'qwen-vl-max'],
    doc: '兼容模式与 OpenAI 接口一致，直接填 DashScope 的 API Key。'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    visionModels: ['gpt-4o', 'gpt-4o-mini'],
    doc: 'gpt-4o-mini 性价比高，国内网络环境需自行保证可直连。'
  },
  {
    id: 'custom',
    name: '自定义',
    baseURL: '',
    models: [],
    visionModels: [],
    doc: '任何 OpenAI 兼容的自建或中转服务，地址请填到 /v1 一级，不含 /chat/completions。'
  }
];

/**
 * 拍照识别的转录指令（方案 §4.5 原文），随图片一起发给视觉模型。
 * 强调「只转录不批改」，避免模型顺手给建议污染作答框。
 */
var OCR_INSTRUCTION =
  '你是申论答题卡转录助手：把图片中的手写作答逐字转录为纯文本。' +
  '要求：保留原有分段与序号；不要解释、不要批改、不要添加任何多余文字；' +
  '无法辨认的字用 □ 占位；若整图无可识别文字，只输出（未识别到文字）。';

/**
 * 延迟 require utils/utf8.js。
 * 这样即使该文件尚未就位，本模块被其它页面 require 时也不会直接崩溃；
 * 真正发起流式请求前会再确认一次，取不到就以中文错误回报。
 */
function getUtf8() {
  try {
    return require('./utf8.js');
  } catch (e) {
    return null;
  }
}

/** 按 id 取预设 */
function getPreset(id) {
  for (var i = 0; i < PRESETS.length; i++) {
    if (PRESETS[i].id === id) return PRESETS[i];
  }
  return null;
}

/** 配置清洗：去空白、去末尾斜杠、补默认值 */
function normalizeConfig(cfg, ownOnly) {
  var input = cfg || {};
  var session = auth.getSession();
  if (!ownOnly && !String(input.apiKey || '').trim() && session) {
    return { shared: true, baseURL: auth.ORIGIN, apiKey: '', model: 'glm-5.3-flash', visionModel: 'glm-5.3-flash', token: session.token };
  }
  var presetId = String(input.presetId == null ? '' : input.presetId).trim();
  if (!getPreset(presetId)) presetId = 'deepseek';

  var baseURL = String(input.baseURL == null ? '' : input.baseURL).trim();
  if (!baseURL) {
    // 没填地址就用预设的地址补齐（自定义预设本身地址为空，保持为空）
    var preset = getPreset(presetId);
    if (preset && preset.baseURL) baseURL = preset.baseURL;
  }
  // 清洗结尾斜杠及误粘贴的 /chat/completions
  baseURL = baseURL.replace(/\/+$/, '').replace(/\/chat\/completions\/?$/, '');

  return {
    presetId: presetId,
    baseURL: baseURL,
    apiKey: String(input.apiKey == null ? '' : input.apiKey).trim(),
    model: String(input.model == null ? '' : input.model).trim(),
    visionModel: String(input.visionModel == null ? '' : input.visionModel).trim()
  };
}

/** 组装完整请求地址 */
function buildUrl(cfg) {
  return cfg.shared ? auth.ORIGIN + '/api/mp/chat' : cfg.baseURL + '/chat/completions';
}

function buildHeaders(cfg) {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (cfg.shared ? cfg.token : cfg.apiKey) };
}
function isConfigured(cfg) { return !validateConfig(normalizeConfig(cfg)); }

function describeSharedHttpError(status, message) {
  if (status === 401) return '登录已失效，请重新登录账号。';
  if (status === 404) return '小程序服务接口尚未上线，请联系站主发布后端。';
  return '账号模型服务请求失败（HTTP ' + status + '）。' + (message || '请稍后重试。');
}

/** 从非 200 响应体里尽力抠出厂商的错误说明 */
function pickServerMessage(res) {
  var raw = res && res.data;
  if (!raw) return '';
  // 若基础库已解析为 Object
  if (typeof raw === 'object' && !(raw instanceof ArrayBuffer)) {
    var obj = raw;
    if (obj.error) {
      var e = obj.error;
      if (typeof e === 'string') return e;
      return e.message || e.code || '';
    }
    return obj.message || obj.msg || obj.error_msg || obj.code || '';
  }
  if (typeof raw !== 'string') {
    try {
      var utf8 = getUtf8();
      if (utf8 && utf8.createIncrementalDecoder) {
        raw = utf8.createIncrementalDecoder().feed(raw);
      }
    } catch (e) {
      return '';
    }
  }
  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.error) {
        var e2 = parsed.error;
        if (typeof e2 === 'string') return e2;
        return e2.message || e2.code || '';
      }
      return parsed.message || parsed.msg || parsed.error_msg || parsed.code || '';
    }
  } catch (e) {
    // 不是 JSON 就原样截一段
  }
  return String(raw).slice(0, 120);
}

/** HTTP 状态码 → 中文错误 */
function describeHttpError(statusCode, serverMsg) {
  var text;
  if (statusCode === 401) {
    text = '密钥无效或已过期（HTTP 401），请到「我的 → 模型设置」检查 API Key。';
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

/**
 * wx.request 的 fail → 中文错误
 * @param {string} errMsg wx 的 errMsg
 * @param {number} [timeoutSeconds] 本次请求的超时秒数，用于把超时文案说准（流式 120 秒、连通性测试 30 秒）
 */
function describeFailError(errMsg, timeoutSeconds) {
  var raw = String(errMsg == null ? '' : errMsg);
  if (/url not in domain list|not in domain list|合法域名|domain/i.test(raw)) {
    return DOMAIN_HINT;
  }
  if (/timeout|超时/i.test(raw)) {
    var sec = Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : 120;
    return '请求超时（' + sec + ' 秒内没有返回内容），请检查网络或改用响应更快的模型。';
  }
  if (/abort: /i.test(raw)) {
    return raw.replace(/^request:fail abort: /i, '');
  }
  if (/abort/i.test(raw)) {
    return '请求已被中止。';
  }
  if (/ssl|handshake|certificate/i.test(raw)) {
    return '网络安全校验失败：' + raw;
  }
  return '网络请求失败：' + (raw || '未知错误');
}

/** wx 的 errMsg 是否表示请求被页面主动中止（不是网络错误，不该触发降级重试） */
function isAbortError(errMsg) {
  return /abort/i.test(String(errMsg == null ? '' : errMsg));
}

/** 安全调用 handlers 上的可选回调 */
function safeCall(handlers, name, arg) {
  var h = handlers || {};
  if (typeof h[name] === 'function') {
    try {
      h[name](arg);
    } catch (e) {
      console.error('[api] 回调 ' + name + ' 抛出异常：', e);
    }
  }
}

/** 校验配置是否可用，返回中文提示或空串 */
function validateConfig(cfg) {
  if (cfg.shared && cfg.token) return '';
  if (!cfg.baseURL) return '还没有填写模型地址，请到「我的 → 模型设置」选择供应商或填写 baseURL。';
  if (!/^https:\/\//i.test(cfg.baseURL)) return '为保护密钥和作答，模型地址必须以 https:// 开头。';
  if (!cfg.apiKey) return '还没有填写 API Key，请到「我的 → 模型设置」填写。';
  if (!cfg.model) return '还没有选择模型，请到「我的 → 模型设置」选择或手输模型名。';
  return '';
}

/**
 * 非流式请求（降级与连通性测试共用）
 * @returns {Object} wx.request 返回的 RequestTask
 */
function requestOnce(options) {
  return modelRequest.request(options);
}

/**
 * 流式请求的公共内核（chatStream 与 transcribeSheet 共用）
 *
 * 两者的差别只有「发出去的 model 是谁」和「HTTP 错误怎么措辞」，
 * 分块解码、SSE 行解析、降级重试、回调时序完全一致，故抽到这里共用。
 *
 * @param {Object} params
 *   conf      normalizeConfig 之后的配置
 *   messages  OpenAI 格式消息数组
 *   model     本次请求使用的模型名
 *   handlers  {onDelta, onDone, onError}，均可选
 *   describeHttp  可选，HTTP 错误的中文化函数，默认 describeHttpError
 * @returns {Object} RequestTask，供页面在 onUnload 中 abort()
 */
function runStream(params) {
  var conf = params.conf;
  var messages = params.messages || [];
  var handlers = params.handlers || {};
  var model = params.model;
  var describeHttp = params.describeHttp || (conf.shared ? describeSharedHttpError : describeHttpError);

  var utf8 = getUtf8();
  if (!utf8 || typeof utf8.createIncrementalDecoder !== 'function') {
    safeCall(handlers, 'onError', '缺少 utils/utf8.js 增量解码器，无法解析流式分块。');
    return null;
  }

  var decoder = utf8.createIncrementalDecoder();
  var lineBuffer = '';   // 分块可能切断一行，需要跨块缓存
  var fullText = '';
  var settled = false;   // 保证 onDone 只回调一次
  var fallbackTried = false;
  var sawAnyChunk = false;
  var activeTask = null;

  function finish(text) {
    if (settled) return;
    settled = true;
    safeCall(handlers, 'onDone', text);
  }

  function fail(message, forceNoFallback) {
    if (settled) return;
    safeCall(handlers, 'onError', message);
    if (fallbackTried || forceNoFallback) {
      safeCall(handlers, 'onFailFinal', message);
      return;
    }
    fallbackTried = true;
    activeTask = nonStreamCall(conf, messages, model, function (text) {
      // 降级成功：一次性吐出全文，页面可撤下错误卡
      fullText = text;
      if (typeof handlers.onReplace === 'function') {
        safeCall(handlers, 'onReplace', text);
      } else {
        safeCall(handlers, 'onDelta', text);
      }
      finish(text);
    }, function (fallbackMsg) {
      console.error('[api] 降级请求同样失败：' + fallbackMsg);
      safeCall(handlers, 'onFailFinal', fallbackMsg);
    }, describeHttp);
  }

  /** 处理一行 SSE */
  function handleLine(line) {
    var trimmed = line.replace(/\r$/, '');
    if (!trimmed) return;
    if (trimmed.charAt(0) === ':') return; // SSE 注释行（心跳）
    if (trimmed.indexOf('data:') !== 0) return; // 只认 data 行
    var payload = trimmed.slice(5).trim();
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
      fail('模型返回错误：' + (msg || '未知错误'), true);
      return;
    }
    var choices = obj && obj.choices;
    if (!choices || !choices.length) return;
    var delta = choices[0].delta && choices[0].delta.content;
    if (typeof delta === 'string' && delta) {
      fullText += delta;
      safeCall(handlers, 'onDelta', delta);
    }
  }

  activeTask = modelRequest.request({
    url: buildUrl(conf),
    method: 'POST',
    header: buildHeaders(conf),
    data: {
      model: model,
      messages: messages,
      stream: true,
      temperature: 0.3
    },
    enableChunked: true,
    timeout: 120000,
    success: function (res) {
      if (res.statusCode !== 200) {
        var isFatalHttp = res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404;
        fail(describeHttp(res.statusCode, pickServerMessage(res)), isFatalHttp);
        return;
      }
      // 少数服务不真正分块，直接把整段 JSON 当普通响应返回
      if (!sawAnyChunk && typeof res.data === 'string' && res.data.charAt(0) === '{') {
        var text = readPlainAnswer(res.data);
        if (text !== null) {
          safeCall(handlers, 'onDelta', text);
          finish(text);
        }
        return;
      }
      // 正常分块结束时，消费剩余缓存行
      if (lineBuffer) {
        handleLine(lineBuffer);
        lineBuffer = '';
      }
      if (decoder && typeof decoder.flush === 'function') {
        var flushed = decoder.flush();
        if (flushed) {
          fullText += flushed;
          safeCall(handlers, 'onDelta', flushed);
        }
      }
      if (!settled) {
        finish(fullText);
      }
    },
    fail: function (err) {
      var raw = err && err.errMsg;
      if (isAbortError(raw)) {
        if (settled) return;
        settled = true;
        safeCall(handlers, 'onError', describeFailError(raw));
        safeCall(handlers, 'onFailFinal', describeFailError(raw));
        return;
      }
      var isDomain = raw && raw.indexOf('url not in domain list') !== -1;
      fail(describeFailError(raw), isDomain);
    }
  });

  // 微信原生：分块事件挂载在 RequestTask 上
  if (activeTask && typeof activeTask.onChunkReceived === 'function') {
    activeTask.onChunkReceived(function (res) {
      if (settled) return;
      var chunk = res.data;
      if (!chunk) return;
      sawAnyChunk = true;
      var text;
      try {
        text = decoder.feed(chunk); // ArrayBuffer → 增量 UTF-8 解码
      } catch (e) {
        fail('解析流式分块失败：' + (e && e.message ? e.message : '未知错误'), true);
        return;
      }
      if (!text) return;
      lineBuffer += text;
      var idx;
      while ((idx = lineBuffer.indexOf('\n')) !== -1) {
        var line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        handleLine(line);
        if (settled) return;
      }
    });
  }

  return {
    abort: function () {
      settled = true;
      if (activeTask && typeof activeTask.abort === 'function') {
        activeTask.abort();
      }
    }
  };
}

/**
 * 流式对话
 * @param {Object} cfg  {baseURL, apiKey, model}
 * @param {Array}  messages  OpenAI 格式的消息数组
 * @param {Object} handlers {onDelta, onDone, onError}，均可选
 * @returns {Object} RequestTask，供页面在 onUnload 中 abort()
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
    model: conf.model,
    handlers: handlers
  });
}

/** 视觉模型的 HTTP 错误措辞：400 且提到 image/content/vision 时给出专门提示（方案 §4.5） */
function describeVisionHttpError(statusCode, serverMsg) {
  if (statusCode === 400 && /image|content|vision/i.test(String(serverMsg || ''))) {
    var text = '当前模型可能不支持图片输入，请到设置页配置视觉模型。';
    if (serverMsg) text += ' 厂商提示：' + serverMsg;
    return text;
  }
  return describeHttpError(statusCode, serverMsg);
}

/**
 * 拍照识别作答：把答题卡照片转录为纯文本（方案 §4.5）
 *
 * @param {Object} cfg  {baseURL, apiKey, model, visionModel}；visionModel 为空时回退 model
 * @param {string} imageBase64  图片的 base64 内容（不带 data: 前缀）
 * @param {Object} handlers {onDelta, onDone, onError}，均可选
 * @param {string} [mimeType] 图片 MIME，默认 image/jpeg；调用方按文件后缀推断（png → image/png）
 * @returns {Object} RequestTask，供页面在识别中 abort()
 */
function transcribeSheet(cfg, imageBase64, handlers, mimeType) {
  var conf = normalizeConfig(cfg);
  var raw = cfg || {};
  // 视觉模型优先，未配置时回退主模型（方案 §4.5）
  var model = conf.shared ? conf.visionModel : String(raw.visionModel == null ? '' : raw.visionModel).trim() || conf.model;
  conf.model = model;

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
    model: model,
    handlers: handlers,
    describeHttp: conf.shared ? describeSharedHttpError : describeVisionHttpError
  });
}

/** 从一次性（非流式）响应体里取 answer 文本 */
function readPlainAnswer(raw) {
  try {
    var obj = (raw && typeof raw === 'object' && !(raw instanceof ArrayBuffer))
      ? raw
      : JSON.parse(raw);
    var text = obj && obj.choices && obj.choices[0] &&
      obj.choices[0].message && obj.choices[0].message.content;
    if (typeof text === 'string') return text;
  } catch (e) {
    // 不是标准结构，交给上层处理
  }
  return null;
}

/**
 * 非流式调用（降级通道）
 * @param {string} model 本次使用的模型名（视觉转录时可能是 visionModel）
 * @param {Function} onSuccess 接收 answer 文本
 * @param {Function} onFail    接收中文错误
 * @param {Function} [describeHttp] HTTP 错误的中文化函数（视觉转录传入专属措辞），默认 describeHttpError
 * @returns {Object} RequestTask
 */
function nonStreamCall(cfg, messages, model, onSuccess, onFail, describeHttp) {
  var http = describeHttp || describeHttpError;
  return modelRequest.request({
    url: buildUrl(cfg),
    method: 'POST',
    header: buildHeaders(cfg),
    data: {
      model: model || cfg.model,
      messages: messages || [],
      stream: false,
      temperature: 0.3
    },
    timeout: 120000,
    success: function (res) {
      if (res.statusCode !== 200) {
        onFail(http(res.statusCode, pickServerMessage(res)));
        return;
      }
      var text = readPlainAnswer(res.data);
      if (text === null) {
        onFail('模型返回的内容无法解析，请稍后重试。');
        return;
      }
      onSuccess(text);
    },
    fail: function (err) {
      onFail(describeFailError(err && err.errMsg, 120));
    }
  });
}

/**
 * 连通性测试：非流式 ping，max_tokens 8
 * @returns {Promise<{ok: boolean, message: string, latencyMs: number}>}
 */
function testConnection(cfg, ownOnly) {
  return new Promise(function (resolve) {
    var conf = normalizeConfig(cfg, ownOnly);
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
    modelRequest.request({
      url: buildUrl(conf),
      method: 'POST',
      header: buildHeaders(conf),
      data: {
        model: conf.model,
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
        max_tokens: 8,
        temperature: 0.3
      },
      timeout: 30000,
      success: function (res) {
        if (res.statusCode !== 200) {
          finish(false, describeHttpError(res.statusCode, pickServerMessage(res)));
          return;
        }
        var text = readPlainAnswer(res.data);
        if (text === null) {
          finish(false, '模型返回的内容无法解析，请确认地址是否为 OpenAI 兼容格式。');
          return;
        }
        finish(true, '连接成功，模型 ' + conf.model + ' 可用。');
      },
      fail: function (err) {
        finish(false, describeFailError(err && err.errMsg, 30));
      }
    });
  });
}

module.exports = {
  isConfigured: isConfigured,
  PRESETS: PRESETS,
  DOMAIN_HINT: DOMAIN_HINT,
  OCR_INSTRUCTION: OCR_INSTRUCTION,
  getPreset: getPreset,
  normalizeConfig: normalizeConfig,
  chatStream: chatStream,
  transcribeSheet: transcribeSheet,
  testConnection: testConnection
};
