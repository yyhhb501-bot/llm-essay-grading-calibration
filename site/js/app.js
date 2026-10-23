/**
 * site/js/app.js —— 七视图单页应用（方案-网站.md §4）
 *
 * 视图：#/grade 批改 · #/result 结果 · #/chat 陪练 · #/papers 真题
 *       #/study 备考 · #/history 历史 · #/settings 设置
 *
 * 关键约定（与小程序版保持一致）：
 *   - 流式：批改与陪练都走 site/js/api.js 的流式渲染，每 300ms 节流重渲染一次；
 *   - scores：结果页用 site/js/md.js 的 parseScores（最后一个 ```scores 围栏），
 *     批改流式期间把累计文本节流写回 localStorage，结果页每 300ms 读一次跟随进度；
 *   - 陪练的名师专题注入路由表 REF_ROUTES 照搬小程序 pages/chat/chat.js。
 */
(function (root, doc) {
  'use strict';

  var Store = root.Store;
  var MD = root.MD;
  var Api = root.Api;
  var Prompts = root.Prompts;
  var References = root.References;
  var Papers = root.Papers;

  // ================= 常量 =================

  /** 五类题型（与小程序版 grade.js 一致） */
  var TYPE_OPTIONS = ['归纳概括', '综合分析', '提出对策', '公文写作', '文章写作'];

  /** 顶部快捷指令（照抄小程序版 chat.js 的 QUICK_ASKS） */
  var QUICK_ASKS = [
    '这道申论题怎么做',
    '归纳概括怎么找点',
    '申论大作文怎么写',
    '帮我做一套申论真题',
    '备考规划'
  ];

  /**
   * 名师专题参考路由表（照搬小程序 pages/chat/chat.js 的 REF_ROUTES）
   * 按用户最新消息命中正则，依序收集对应专题，最多注入 3 篇、总量封顶。
   */
  var REF_ROUTES = [
    { re: /李梦圆|小马哥|站长|白鹭|袁东|单淑玲|飞扬|名师|哪位老师/, keys: ['mingshi-duibi', 'mingshi-xiangjie'] },
    { re: /大作文|文章写作|立意|分论点|论证|议论文/, keys: ['dazuowen', 'fenlundian-lunzheng'] },
    { re: /公文|文种|讲话稿|倡议书|建议书|公开信|短评|汇报|提纲|通知/, keys: ['gongwen-xiezuo', 'gongwen-gezhi'] },
    { re: /综合分析|词句理解|观点分析|启示|比较分析/, keys: ['zonghe-fenxi'] },
    { re: /归纳概括|单一题|概括|找点|要点/, keys: ['danyiti-guina', 'cailiao-yuedu'] },
    { re: /对策/, keys: ['duice-tichu'] },
    { re: /金句|素材|范文|模板|开头|结尾/, keys: ['jinju-sucai'] },
    { re: /规范表达|规范词|政府用语|口语/, keys: ['guifan-biaoda'] },
    { re: /备考|规划|上岸|在职|全职|几个月|几周/, keys: ['beikao-jihua'] },
    { re: /复盘|套题|错题/, keys: ['taoti-fupan'] },
    { re: /真题|例题|解析/, keys: ['zhenti-shili', 'taoti-fupan'] },
    { re: /材料|阅读|批注/, keys: ['cailiao-yuedu'] },
    { re: /怎么做|怎么答|怎么写|怎么学/, keys: ['danyiti-guina', 'cailiao-yuedu'] },
    { re: /练习|练一练|出题/, keys: ['shizhan-lianxi'] }
  ];

  var REF_MAX_CHARS = 26000; // 注入专题的总字符上限，避免 system 过长

  /** 多轮对话保留最近多少条（不含 system） */
  var HISTORY_TAIL = 20;

  /** 流式渲染 / 落盘节流间隔（毫秒），方案 §4 明确 300ms */
  var RENDER_THROTTLE = 300;

  /** 批改流写回 localStorage 的节流间隔（毫秒），与小程序版一致 */
  var FLUSH_INTERVAL = 500;

  /** 拍照识别：canvas 压缩后的长边上限（方案 §4.5） */
  var MAX_IMAGE_SIDE = 1600;

  /** 压缩后的 JPEG 质量（长边已限到 1600，识别用 0.8 足够） */
  var IMAGE_QUALITY = 0.8;

  /** 备考：基础水平 / 时长 / 目标 / 周数候选项（与小程序版 study.js 一致） */
  var LEVELS = [
    '零基础：没考过，材料读不懂',
    '入门：考过但没方向，题型不分',
    '中等：归纳概括能写，综合分析与大作文没底',
    '较好：能写满字数，主要问题是要点覆盖不全'
  ];
  var DAILY_HOURS = [
    { label: '0.5 小时', value: 0.5 },
    { label: '1 小时', value: 1 },
    { label: '1.5 小时', value: 1.5 },
    { label: '2 小时', value: 2 },
    { label: '3 小时以上', value: 3 }
  ];
  var DAILY_LABELS = DAILY_HOURS.map(function (h) { return h.label; });
  var TARGETS = [
    '国考（副省级/地市级）',
    '省考（申论 A/B/C 类）',
    '事业单位综合应用能力',
    '选调生',
    '其他公考岗位'
  ];
  var WEEK_OPTIONS = ['4 周', '8 周', '12 周', '16 周', '24 周', '32 周'];
  var MAX_WEEKS = 32;

  /**
   * 备考规划附加指令：解除 COACH_PROMPT 的「先反问三题」，
   * 并规定按「第X周」二级标题输出，便于页面按周拆分打卡（照搬小程序版 study.js）。
   */
  var PLAN_INSTRUCTION = [
    '（本次为「备考计划生成」模式，用户已在表单中一次性回答了你需要反问的全部问题，',
    '请不要再反问，直接按下面四步输出计划：）',
    '',
    '第一步：用一句话复述你理解到的备考者画像（基础、每日时长、目标岗位、剩余周数）；',
    '第二步：按「第X周：本周主题」作为二级标题逐周排布计划，覆盖全部剩余周数；',
    '第三步：每周必须写清四项内容——训练量（练什么题型、几道、每天多少分钟）、',
    '背诵清单（背什么，如四类找点词、公文格式）、复盘动作（批改后怎么改）、打卡节点；',
    '第四步：末尾给出三条「本周最重要的三件事」与一句打卡提醒。',
    '',
    '前期做专项突破，中期做套题训练，后期限时与背诵；周数少时按比例合并，不要输出超过 ' +
    MAX_WEEKS + ' 周。',
    '只用受限 markdown 子集：二级标题、三级标题、加粗、无序列表、有序列表、引用块与普通段落；',
    '禁止表格、图片、链接、emoji。不要输出 scores 代码块。'
  ].join('\n');

  /** 批注类型 → 标签配色（照搬小程序版 result.js） */
  var ISSUE_TAG_CLASS = {
    '要点缺失': 'tag-red',
    '表述不规范': 'tag-gold',
    '逻辑': 'tag-ink',
    '卷面': 'tag-sub'
  };

  // ================= 工具函数 =================

  function $(id) {
    return doc.getElementById(id);
  }

  /** HTML 转义，所有插值必过这一道 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pad2(n) {
    n = Math.floor(Math.abs(n));
    return n < 10 ? '0' + n : '' + n;
  }

  /** 「2026-10-05 18:20」 */
  function formatTime(input) {
    if (!input) return '';
    var d = new Date(input);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 相对时间：刚刚 / 12分钟前 / 3小时前 / 10月03日 */
  function fromNow(input) {
    if (!input) return '';
    var d = new Date(input);
    if (isNaN(d.getTime())) return '';
    var diff = Date.now() - d.getTime();
    if (diff < 0) diff = 0;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    var today = new Date();
    if (d.getFullYear() === today.getFullYear()) return (d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日';
  }

  /** 中文字数统计：汉字按字计，英文单词按词计，忽略空白（与小程序版 format.countWords 一致） */
  function countWords(text) {
    if (!text) return 0;
    var s = String(text);
    var cn = s.match(/[一-龥぀-ヿ]/g);
    var en = s.match(/[A-Za-z0-9]+/g);
    return (cn ? cn.length : 0) + (en ? en.length : 0);
  }

  /** 按字数给出简短的作答长度评价（与小程序版 format.judgeLength 一致） */
  function judgeLength(words) {
    var n = Number(words) || 0;
    if (n <= 0) return '尚未落笔';
    return '已输入约 ' + n + ' 字，请对照本题字数要求';
  }

  /** 从题目要求中提取明确的字数限制；没有明确数值时不自行设定标准。 */
  function updateLengthStandard() {
    var tip = $('grade-length-standard');
    var questionEl = $('grade-question');
    if (!tip || !questionEl) return;

    var question = String(questionEl.value || '');
    var match = question.match(/([0-9]{1,4})\s*[-—–~～至到]\s*([0-9]{1,4})\s*(?:个?字)/);
    if (match) {
      tip.textContent = '字数要求：' + match[1] + '～' + match[2] + ' 字';
      return;
    }

    match = question.match(/(?:不超过|不得超过|控制在|最多|至多|限)\s*([0-9]{1,4})\s*(?:个?字)/);
    if (!match) match = question.match(/([0-9]{1,4})\s*(?:个?字)以内/);
    if (match) {
      tip.textContent = '字数要求：不超过 ' + match[1] + ' 字';
      return;
    }

    match = question.match(/(?:不少于|不得少于|至少)\s*([0-9]{1,4})\s*(?:个?字)/);
    if (match) {
      tip.textContent = '字数要求：不少于 ' + match[1] + ' 字';
      return;
    }

    match = question.match(/(?:约|大约)\s*([0-9]{1,4})\s*(?:个?字)|([0-9]{1,4})\s*(?:个?字)左右/);
    if (match) {
      tip.textContent = '建议约 ' + (match[1] || match[2]) + ' 字';
      return;
    }

    tip.textContent = '按题目要求作答';
  }

  /** 分数保留一位小数 */
  function formatScore(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  /** 截断长文本用于列表摘要 */
  function brief(text, len) {
    var n = typeof len === 'number' ? len : 40;
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  var toastTimer = null;
  /** 轻提示 */
  function toast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, Number(ms) > 0 ? Number(ms) : 2200);
  }

  /**
   * 把受限 markdown 渲染成 HTML（转义后拼标签，杜绝 XSS）。
   * @param {string} text
   * @returns {string} HTML 片段
   */
  function mdToHtml(text) {
    var blocks = MD.parseBlocks(text);
    var out = '';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i] || {};
      var segs = b.segments || [];
      var inner = '';
      for (var j = 0; j < segs.length; j++) {
        var t = esc(segs[j].text);
        inner += segs[j].bold ? '<strong>' + t + '</strong>' : t;
      }
      if (b.type === 'hr') {
        out += '<div class="md-hr"></div>';
      } else if (b.type === 'h2') {
        out += '<div class="md-h2">' + inner + '</div>';
      } else if (b.type === 'h3') {
        out += '<div class="md-h3">' + inner + '</div>';
      } else if (b.type === 'quote') {
        out += '<div class="md-quote">' + inner + '</div>';
      } else if (b.type === 'li') {
        out += '<div class="md-li">' + inner + '</div>';
      } else {
        out += '<p class="md-p">' + inner + '</p>';
      }
    }
    return out;
  }

  /** 填 <select> 的选项 */
  function fillSelect(el, options, selected) {
    if (!el) return;
    var html = '';
    for (var i = 0; i < options.length; i++) {
      html += '<option value="' + esc(options[i]) + '"' +
        (options[i] === selected ? ' selected' : '') + '>' + esc(options[i]) + '</option>';
    }
    el.innerHTML = html;
  }

  /**
   * 复制到剪贴板（navigator.clipboard 不可用时退回 textarea + execCommand）
   * @param {string} text
   * @returns {boolean}
   */
  function copyText(text) {
    if (!text) return false;
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        root.navigator.clipboard.writeText(text).then(function () {
          toast('已复制到剪贴板');
        }, function () {
          legacyCopy(text);
        });
        return true;
      }
    } catch (e) {
      // 落到 legacy
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    try {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      doc.body.appendChild(ta);
      ta.select();
      var ok = doc.execCommand('copy');
      doc.body.removeChild(ta);
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文字');
      return ok;
    } catch (e) {
      toast('复制失败，请手动选择文字');
      return false;
    }
  }

  // ================= 全局运行时状态 =================

  var State = {
    view: 'grade',
    resultId: '',
    gradeStream: null,   // 批改页发起的共享流 {task, recordId}
    gradeBuf: '',
    gradeLastFlush: 0,
    gradeSeq: 0,         // 批改流代际：每次发起/中止 +1，用于丢弃迟到的旧回调
    prefillAnchor: null, // 真题预填时捕获的共识锚点（两阶段批改用），用户改动题目即失效
    scanTask: null,
    scanCanceled: false,
    scanText: '',
    chat: {
      messages: [],
      sending: false,
      readonly: false,
      viewRecordId: '',
      buf: '',
      aiMsgId: '',
      lastRender: 0,
      recordId: '',
      seq: 0,
      task: null
    },
    study: { buf: '', lastRender: 0, task: null },
    historyFilter: 'all',
    openPapers: {}
  };

  /** 下一次消息 id */
  function nextMsgId() {
    State.chat.seq += 1;
    return 'm' + Date.now().toString(36) + State.chat.seq;
  }

  // ================= 路由 =================

  var VIEWS = ['grade', 'result', 'chat', 'papers', 'study', 'history', 'settings'];

  /** 解析当前 hash：#/result?id=xxx → {view:'result', query:{id:'xxx'}} */
  function parseHash() {
    var raw = String(root.location.hash || '').replace(/^#/, '');
    if (!raw || raw === '/') raw = '/grade';
    var parts = raw.split('?');
    var path = parts[0].replace(/^\/+|\/+$/g, '');
    var view = VIEWS.indexOf(path) >= 0 ? path : 'grade';
    var query = {};
    if (parts[1]) {
      var pairs = parts[1].split('&');
      for (var i = 0; i < pairs.length; i++) {
        var kv = pairs[i].split('=');
        if (!kv[0]) continue;
        query[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join('=') || '');
      }
    }
    return { view: view, query: query };
  }

  function go(hash) {
    if (root.location.hash === hash) {
      handleRoute();
    } else {
      root.location.hash = hash;
    }
  }

  var SUBTITLE = {
    grade: '红笔在手，逐句点出得分与丢分',
    result: '五维百分制 · 踩点给分 · 逐句朱批',
    chat: '五大题型教学式引导，按题注入名师专题参考',
    papers: '三套真题，套题到题两级展开',
    study: '先问基础、时间、目标，再排计划',
    history: '批改与对话记录都存在这台设备的浏览器里',
    settings: '账号登录后使用共享模型，也可以配置自己的模型密钥'
  };

  function handleRoute() {
    var route = parseHash();
    State.view = route.view;
    State.resultId = route.view === 'result' ? (route.query.id || '') : '';

    for (var i = 0; i < VIEWS.length; i++) {
      var sec = $('view-' + VIEWS[i]);
      if (sec) sec.hidden = VIEWS[i] !== route.view;
    }
    var sub = $('topbar-sub');
    if (sub) sub.textContent = SUBTITLE[route.view] || '';

    var tabs = doc.querySelectorAll('#tabbar .tab');
    for (var j = 0; j < tabs.length; j++) {
      var t = tabs[j];
      var isActive = t.getAttribute('data-view') === route.view ||
        (route.view === 'result' && t.getAttribute('data-view') === 'grade');
      t.className = isActive ? 'tab active' : 'tab';
    }

    var bar = $('chat-bar');
    var onChat = route.view === 'chat';
    if (bar) bar.hidden = !onChat;
    doc.body.className = onChat ? 'has-chat-bar' : '';

    if (route.view === 'grade') mountGrade();
    else if (route.view === 'result') mountResult();
    else if (route.view === 'chat') mountChat(route.query.id || '');
    else if (route.view === 'papers') mountPapers();
    else if (route.view === 'study') mountStudy();
    else if (route.view === 'history') mountHistory();
    else if (route.view === 'settings') mountSettings();

    root.scrollTo(0, 0);
  }

  // ================= 视图一：批改 =================

  function mountGrade() {
    var typeEl = $('grade-type');
    if (typeEl && !typeEl.options.length) fillSelect(typeEl, TYPE_OPTIONS, TYPE_OPTIONS[0]);
    refreshGradeTip();
    var status = $('grade-scan-status');
    if (status) status.textContent = '';
  }

  function refreshGradeTip() {
    var cfg = Store.getConfig();
    var ok = Store.isConfigured(cfg);
    var tip = $('grade-tip');
    if (!tip) return;
    tip.textContent = ok
      ? (cfg.mode === 'server'
        ? '已登录：使用站主提供的共享模型，无需填写 API Key。'
        : '当前是自带 Key 模式：请求会带上你自己填的密钥转发给模型厂商。')
      : (cfg.mode === 'server'
        ? '请先登录账号。'
        : '还没有填齐 baseURL / API Key / 模型名，请先到设置页填写。');
    tip.className = ok ? 'field-hint' : 'field-hint danger';
  }

  /** 组装批改 messages：system 用 GRADE_PROMPT 并注入规范表达速查，user 按四段标签分段 */
  function buildGradeMessages(cfg) {
    var typeEl = $('grade-type');
    var typeName = typeEl && typeEl.value ? typeEl.value : TYPE_OPTIONS[0];
    var question = ($('grade-question').value || '').trim();
    var material = ($('grade-material').value || '').trim();
    var answer = ($('grade-answer').value || '').trim();
    var user = [
      '【题型】' + typeName,
      '【题目】' + question,
      '【给定资料】' + (material ? material : '（未提供）'),
      '【参考答案】' + (($('grade-reference').value || '').trim() || '（未提供）'),
      '【考生作答】' + answer
    ].join('\n\n');
    var system = buildGradeSystem();
    return {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      system: system,
      user: user,
      typeName: typeName,
      question: question,
      answer: answer
    };
  }

  /** 批改 system：GRADE_PROMPT + 规范表达速查 + 质量红线（首轮与重试共用同一份） */
  function buildGradeSystem() {
    var system = Prompts.GRADE_PROMPT;
    var guifan = References.REF && References.REF['guifan-biaoda'];
    if (typeof guifan === 'string' && guifan) {
      system += '\n\n【规范表达速查】评「语言规范」与给修改建议时参考：\n' + guifan;
    }
    system += '\n\n' + Prompts.QUALITY_RULES;
    return system;
  }

  function syncTypeSegmented(typeName) {
    var typeSeg = $('grade-type-segmented');
    if (!typeSeg) return;
    var btns = typeSeg.querySelectorAll('.type-segment');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-type') === typeName) {
        btns[i].classList.add('active');
      } else {
        btns[i].classList.remove('active');
      }
    }
  }

  function loadPresetQuestion(presetId) {
    var pList = Papers && Papers.PAPERS;
    if (!pList || !pList.length) return;
    var targetQ = null;
    if (presetId === 'guokao_fusheng_01') {
      targetQ = pList[0] && pList[0].questions && pList[0].questions[0];
    } else if (presetId === 'guokao_fusheng_02') {
      targetQ = pList[0] && pList[0].questions && pList[0].questions[1];
    } else if (presetId === 'dazuowen_lu') {
      targetQ = pList[0] && pList[0].questions && pList[0].questions[2];
    } else {
      targetQ = pList[0] && pList[0].questions && pList[0].questions[0];
    }
    if (!targetQ) return;

    var typeEl = $('grade-type');
    if (typeEl) {
      typeEl.value = targetQ.type || '归纳概括';
      syncTypeSegmented(typeEl.value);
    }
    var qEl = $('grade-question');
    if (qEl) qEl.value = targetQ.question || '';
    updateLengthStandard();
    var mEl = $('grade-material');
    if (mEl) mEl.value = targetQ.material || '';

    var mWrap = $('grade-material-wrap');
    var mArrow = $('grade-material-arrow');
    if (mWrap) mWrap.classList.remove('is-collapsed');
    if (mArrow) mArrow.textContent = '收起 ▴';

    toast('已载入真题：' + targetQ.type);
  }

  function fillSampleAnswer() {
    var sample = [
      '当前县域数字技术下沉主要面临以下堵点与问题：',
      '一是设备闲置严重。乡村医生操作能力欠缺，网络带宽不足，导致设备常年空置。',
      '二是运维保障缺位。基层技术能力有限，厂家响应不及时，缺乏长效运维机制。',
      '三是基层负担加重。线上台账繁多，填表应付检查，滋生数字形式主义。',
      '四是数据割裂孤岛。部门标准不一，一人多档，信息壁垒尚未打通。',
      '五是配套机制脱节。仅下沉设备账号，人才、数据与协同机制未有效同步下沉。'
    ].join('\n');
    var ansEl = $('grade-answer');
    if (ansEl) ansEl.value = sample;
    updateAnswerMeta();
    toast('已填入标准答卷范例，点击下方按钮开始批改！');
  }

  function onGradeSubmit() {
    var built = buildGradeMessages(Store.getConfig());
    if (!built.question) {
      toast('请先填写题目');
      return;
    }
    if (!built.answer) {
      toast('请先粘贴你的作答');
      return;
    }
    if (!Store.isConfigured()) {
      toast('还没有配置接入方式，请先到设置页设置');
      go('#/settings');
      return;
    }
    // 真题预填且题目未被改动 → 走「共识锚点两阶段」；否则单阶段（个人自拟题照旧）
    var anchor = takeValidGradeAnchor(built);
    var entry = Store.addHistory({
      type: 'grade',
      title: built.typeName + '·' + brief(built.question, 16),
      payload: {
        questionType: built.typeName,
        question: built.question,
        material: ($('grade-material').value || '').trim(),
        referenceAnswer: ($('grade-reference').value || '').trim(),
        answer: built.answer,
        content: '',
        scores: null,
        status: 'streaming',
        error: '',
        createdAt: Date.now()
      }
    });
    abortGradeStream();
    // 必须先挂上 gradeStream 再跳转：mountResult 看到 streaming 却没有对应流时会标记「中断」
    State.gradeStream = { task: null, recordId: entry.id };
    var gen = bumpGradeSeq();
    go('#/result?id=' + encodeURIComponent(entry.id));
    if (anchor) startAnchorStage(entry.id, anchor, built, gen);
    else startGradeStream(entry.id, built.messages);
  }

  /**
   * 发起批改流：累计文本按 FLUSH_INTERVAL 节流写回该条历史记录。
   * 注意 State.gradeStream 必须先挂上再调 Api.chatStream —— 配置不全时 api 层会
   * 同步回调 onError，那一刻 flushGradeToStore 要能拿到 recordId。
   * 同样，出错后不立刻清空 gradeStream：api 层可能正在降级重试，降级成功的
   * onDelta/onDone 还要靠这个 recordId 把全文落盘、把状态从 error 改回 done。
   */
  function startGradeStream(recordId, messages) {
    bumpGradeSeq(); // 新代际：在途的两阶段判定回调（若有）从此作废
    State.gradeBuf = '';
    State.gradeLastFlush = 0;
    var hadError = false;
    var cfg = Store.getConfig();
    State.gradeStream = { task: null, recordId: recordId };
    var task = Api.chatStream(cfg, messages, {
      onDelta: function (delta) {
        if (hadError) {
          State.gradeBuf = delta;
        } else {
          State.gradeBuf += delta;
        }
        flushGradeToStore(false, '', '');
      },
      onReplace: function (full) {
        State.gradeBuf = full || '';
        flushGradeToStore(false, '', '');
      },
      onDone: function (full) {
        State.gradeBuf = (typeof full === 'string' && full) ? full : State.gradeBuf;
        flushGradeToStore(true, '', 'done');
        finishGradeStream();
      },
      onError: function (msg) {
        hadError = true;
        maybePromptCode(msg);
        flushGradeToStore(true, msg, 'error');
        // 不在这里 finishGradeStream：降级成功后的 onDone 仍需落盘
      }
    });
    if (State.gradeStream && State.gradeStream.recordId === recordId) {
      State.gradeStream.task = task || null;
    }
    if (!task) {
      // 配置不全：api 层没有降级机会，此刻才收尾
      finishGradeStream();
    }
  }

  function flushGradeToStore(force, error, status) {
    var recordId = State.gradeStream ? State.gradeStream.recordId : '';
    if (!recordId) return;
    var now = Date.now();
    if (!force && now - State.gradeLastFlush < FLUSH_INTERVAL) return;
    State.gradeLastFlush = now;

    var item = Store.getHistoryById(recordId);
    if (!item) return;
    var payload = item.payload || {};
    payload.content = State.gradeBuf || '';
    payload.updatedAt = now;
    if (error) payload.error = error;
    if (status) payload.status = status;
    if (status === 'done') {
      payload.scores = MD.parseScores(payload.content); // 存一份快照，历史列表可直接读
      payload.error = '';
    }
    Store.updateHistory(recordId, { payload: payload });
  }

  function finishGradeStream() {
    State.gradeStream = null;
  }

  function abortGradeStream() {
    bumpGradeSeq(); // 中止即作废所有在途回调
    if (State.gradeStream && State.gradeStream.task && typeof State.gradeStream.task.abort === 'function') {
      try {
        State.gradeStream.task.abort();
      } catch (e) { /* 忽略 */ }
    }
    State.gradeStream = null;
  }

  /** 由结果页触发：把仍停在 streaming 的记录落回 error，避免历史里永远转圈 */
  function finalizeOrphanStream(recordId) {
    var item = Store.getHistoryById(recordId);
    if (!item) return;
    var payload = item.payload || {};
    if (payload.status === 'streaming') {
      payload.status = 'error';
      payload.error = '批改被中断（离开了结果页），已保留已生成的内容，可点重试重新批改。';
      Store.updateHistory(recordId, { payload: payload });
    }
  }

  // ---- 闭环可复算覆盖率（共识锚点两阶段批改） ----
  //
  // 真题预填时捕获共识锚点（prefillFromPaperQuestion → State.prefillAnchor）；提交批改且题目未被改动时：
  //   Stage A   窄任务判定共识点命中（Api.chatOnce + Prompts.ANCHOR_MATCH_PROMPT，低温、关思考）
  //   Program   tools/coverage-score.js（浏览器端 window.CoverageScore）算加权覆盖率与要点完整度
  //   Stage B   主批改提示词里注入【共识锚点程序核算】块，要求模型直接采用核算分值
  // 个人自拟题、无共识数据、Stage A 失败、依赖缺失 → 一律静默回退原有单阶段批改，不向用户报错。

  /** 批改流代际 +1：任何一次新的发起/中止都会作废在途的旧回调 */
  function bumpGradeSeq() {
    State.gradeSeq += 1;
    return State.gradeSeq;
  }

  /** 题干等值比较（去掉全部空白），用户只改空白不算改题 */
  function normQuestion(text) {
    return String(text == null ? '' : text).replace(/\s+/g, '');
  }

  /** 提交时刻取锚点：无锚点数据或题目被改动过 → null（走单阶段） */
  function takeValidGradeAnchor(built) {
    var anchor = State.prefillAnchor;
    if (!anchor || !built || !built.answer) return null;
    if (!anchor.groups || !anchor.groups.length) return null;
    if (normQuestion(anchor.questionValue) !== normQuestion(built.question)) return null;
    return anchor;
  }

  /** 该 recordId 仍是当前正在跑的批改流吗（用户离开、重试、重开都会让它失效） */
  function isCurrentGrade(recordId) {
    return !!recordId && !!State.gradeStream && State.gradeStream.recordId === recordId;
  }

  /** 把进度文案写进记录正文（结果页轮询可见），Stage B 的首个增量到达后会整体覆盖 */
  function setGradeProgressText(recordId, text) {
    var item = Store.getHistoryById(recordId);
    if (!item) return;
    var payload = item.payload || {};
    payload.content = text || '';
    payload.updatedAt = Date.now();
    Store.updateHistory(recordId, { payload: payload });
  }

  /** Stage A 的 messages：采分点组带固定 id（0 起）+ 考生作答，与 tools/match-student-points.js 同契约 */
  function buildAnchorMessages(anchor, answer) {
    var groups = anchor.groups.map(function (g, i) {
      return { id: i, text: g.text, consensus: g.count >= 2 ? g.count + '家机构' : '单源' };
    });
    return [
      { role: 'system', content: Prompts.ANCHOR_MATCH_PROMPT },
      { role: 'user', content: '【采分点组】\n' + JSON.stringify(groups, null, 1) + '\n\n【考生作答】\n' + answer }
    ];
  }

  /** 模型偶尔按 1 起编号：仅当"命中的 id 恰为 1..n 且没有 0"时整体左移一格，其余原样 */
  function normalizeHits(hits, groupCount) {
    if (!hits || !hits.length || groupCount < 2) return hits;
    var seen = {};
    var min = Infinity;
    var max = -Infinity;
    hits.forEach(function (h) {
      seen[h.groupId] = true;
      if (h.groupId < min) min = h.groupId;
      if (h.groupId > max) max = h.groupId;
    });
    if (min === 1 && max === groupCount && !seen[0]) {
      return hits.map(function (h) {
        return { groupId: h.groupId - 1, hit: h.hit, evidence: h.evidence };
      });
    }
    return hits;
  }

  /**
   * 两阶段批改第一步：Stage A 判定 → 程序核算 → Stage B 生成报告。
   * 任一环节失败都静默回退 startGradeStream 单阶段，用户无感。
   */
  function startAnchorStage(recordId, anchor, built, gen) {
    function stillMine() {
      return isCurrentGrade(recordId) && State.gradeSeq === gen;
    }
    function fallback() {
      setGradeProgressText(recordId, '正在进行常规批改，请稍候…');
      startGradeStream(recordId, built.messages);
    }
    var coverage = root.CoverageScore;
    var ready = !!(Prompts.ANCHOR_MATCH_PROMPT && coverage &&
      typeof coverage.parseHits === 'function' && typeof coverage.coverage === 'function' &&
      typeof coverage.renderAnchorBlock === 'function' && typeof coverage.pointDimensionMax === 'function');
    if (!ready) {
      fallback();
      return;
    }
    setGradeProgressText(recordId, '正在逐条核对共识要点（共 ' + anchor.groups.length + ' 组），随后自动生成批改报告…');
    var messages = buildAnchorMessages(anchor, built.answer);
    Api.chatOnce(Store.getConfig(), messages, { temperature: 0.1, thinking: 'disabled', maxTokens: 4000 })
      .then(function (text) {
        if (!stillMine()) return;
        var hits = coverage.parseHits(text);
        if (!hits) {
          fallback();
          return;
        }
        finalizeWithAnchor(recordId, anchor, built, normalizeHits(hits, anchor.groups.length), gen);
      })
      .catch(function () {
        if (!stillMine()) return;
        fallback();
      });
  }

  /** 程序核算覆盖率 → 持久化 payload.anchor → 注入【共识锚点程序核算】块开跑 Stage B */
  function finalizeWithAnchor(recordId, anchor, built, hits, gen) {
    if (!isCurrentGrade(recordId) || State.gradeSeq !== gen) return;
    var cs = root.CoverageScore;
    var groups = anchor.groups;
    var pointMax = cs.pointDimensionMax(built.typeName);
    var cov = cs.coverage(groups, hits);
    var pointScore = cs.pointDimensionScore(cov, pointMax);
    var block = cs.renderAnchorBlock(groups, hits, { dimensionMax: pointMax });
    var item = Store.getHistoryById(recordId);
    if (!item) return; // 记录已被清掉，晚到的结果直接丢
    var payload = item.payload || {};
    payload.anchor = {
      groups: groups,
      hits: hits,
      coverage: cov,
      pointScore: pointScore,
      pointMax: pointMax,
      block: block
    };
    payload.content = '';
    Store.updateHistory(recordId, { payload: payload });
    var messages = [
      { role: 'system', content: built.system },
      { role: 'user', content: built.user + '\n\n【共识锚点程序核算】\n' + block }
    ];
    startGradeStream(recordId, messages);
  }

  // ---- 拍照识别 ----

  /** 读文件 → canvas 压到长边 ≤1600 → base64；失败退回原图 */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = String(reader.result || '');
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width;
            var h = img.naturalHeight || img.height;
            var scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
            var cw = Math.max(1, Math.round(w * scale));
            var ch = Math.max(1, Math.round(h * scale));
            var canvas = doc.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, cw, ch);
            ctx.drawImage(img, 0, 0, cw, ch);
            var out = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
            resolve({ base64: out.split(',')[1] || '', mimeType: 'image/jpeg' });
          } catch (e) {
            // canvas 不可用：退回原图的 data URL
            resolve(fromDataUrl(dataUrl, file.name));
          }
        };
        img.onerror = function () {
          resolve(fromDataUrl(dataUrl, file.name));
        };
        img.src = dataUrl;
      };
      reader.onerror = function () {
        reject(new Error('图片读取失败，请重新拍照。'));
      };
      reader.readAsDataURL(file);
    });
  }

  /** 从 data URL 拆出 base64 与 MIME；MIME 缺失时按文件名后缀推断（与小程序版一致） */
  function fromDataUrl(dataUrl, fileName) {
    var s = String(dataUrl || '');
    var comma = s.indexOf(',');
    var head = comma >= 0 ? s.slice(0, comma) : '';
    var base64 = comma >= 0 ? s.slice(comma + 1) : '';
    var m = /data:([^;,]+)/.exec(head);
    return { base64: base64, mimeType: (m && m[1]) || Api.guessMime(fileName) };
  }

  /** 识别中再点一次 = 取消（与小程序版一致）：中止请求并给出提示 */
  function cancelScan() {
    State.scanCanceled = true;
    abortScan();
    var statusEl = $('grade-scan-status');
    if (statusEl) {
      statusEl.textContent = '识别已取消。';
      statusEl.className = 'field-hint';
    }
  }

  function onPickFile(file) {
    if (!file) return;
    var statusEl = $('grade-scan-status');
    var btn = $('grade-scan');
    State.scanCanceled = false;
    State.scanText = '';
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = '正在压缩图片…';

    compressImage(file).then(function (packed) {
      if (State.scanCanceled) return;
      if (!packed.base64) {
        failScan('图片读取失败，请重新拍照。');
        return;
      }
      startTranscribe(packed.base64, packed.mimeType);
    }).catch(function (err) {
      failScan((err && err.message) || '图片读取失败，请重新拍照。');
    });
  }

  function startTranscribe(base64, mimeType) {
    var statusEl = $('grade-scan-status');
    State.scanText = '';
    if (statusEl) statusEl.textContent = '识别中…';
    var task = Api.transcribeSheet(Store.getConfig(), base64, {
      onDelta: function (delta) {
        if (State.scanCanceled) return;
        State.scanText += delta;
        if (statusEl) statusEl.textContent = '识别中…已转录 ' + countWords(State.scanText) + ' 字';
      },
      onDone: function (full) {
        var text = String(full || State.scanText || '').trim();
        State.scanTask = null;
        if (State.scanCanceled) return;
        endScan();
        if (!text || text === Api.OCR_EMPTY_MARK) {
          toast('未识别到文字，请重拍');
          return;
        }
        fillAnswer(text);
        toast('识别完成，可手动修改');
      },
      onError: function (msg) {
        if (State.scanCanceled) return;
        maybePromptCode(msg);
        failScan(msg);
      }
    }, mimeType);
    State.scanTask = task || null;
    if (!task) endScan(); // 配置不全，api 层已回调 onError
  }

  function fillAnswer(text) {
    var el = $('grade-answer');
    var cur = el.value || '';
    var next = cur && cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' + text : text;
    el.value = next;
    updateAnswerMeta();
  }

  function updateAnswerMeta() {
    var words = countWords($('grade-answer').value);
    $('grade-words').textContent = words;
    var hint = $('grade-length-hint');
    if (hint) {
      hint.textContent = judgeLength(words);
      hint.className = 'length-status-badge' + (words === 0 ? '' : (words >= 150 && words <= 1200 ? ' good' : ' warn'));
    }
  }

  function endScan() {
    State.scanTask = null;
    State.scanText = '';
    var btn = $('grade-scan');
    if (btn) btn.disabled = false;
  }

  function failScan(msg) {
    endScan();
    var statusEl = $('grade-scan-status');
    if (statusEl) {
      statusEl.textContent = String(msg || '识别失败，请重试。');
      statusEl.className = 'field-hint danger';
    }
  }

  function abortScan() {
    State.scanCanceled = true;
    if (State.scanTask && typeof State.scanTask.abort === 'function') {
      try {
        State.scanTask.abort();
      } catch (e) { /* 忽略 */ }
    }
    State.scanTask = null;
    endScan();
  }

  // ================= 视图二：结果 =================

  var resultTimer = null;
  var resultLastText = '';

  function mountResult() {
    stopResultPolling();
    resultLastText = '';
    var id = State.resultId;
    if (!id) {
      renderResultMissing();
      return;
    }
    var item = Store.getHistoryById(id);
    if (item && item.payload && item.payload.status === 'streaming') {
      if (!State.gradeStream || State.gradeStream.recordId !== id) {
        finalizeOrphanStream(id);
        item = Store.getHistoryById(id);
      }
    }
    applyResultRecord(item);
  }

  function renderResultMissing() {
    $('result-total').textContent = '—';
    $('result-grade').hidden = true;
    $('result-dims').innerHTML = '';
    $('result-body').innerHTML = '<div class="empty">没有找到这条批改记录，可能已被清空。</div>';
    $('result-status').textContent = '';
    $('result-meta').textContent = '';
    $('result-error').hidden = true;
    $('result-issues-card').hidden = true;
    $('result-upgrade-card').hidden = true;
    $('result-paper-card').hidden = true;
    $('result-score-card').hidden = true;
    var calibRow = $('result-calibration-row');
    if (calibRow) calibRow.hidden = true;
  }

  /** 把一条历史记录渲染进结果页（与小程序版 result.js 的 applyItem 同构） */
  function applyResultRecord(item) {
    if (!item) {
      renderResultMissing();
      return;
    }
    var payload = item.payload || {};
    var text = payload.content || '';
    var status = payload.status || (text ? 'done' : '');
    var scores = MD.parseScores(text) || payload.scores || null;
    var view = buildScoreView(scores);
    var streaming = status === 'streaming';
    var changed = text !== resultLastText;
    resultLastText = text;

    $('result-score-card').hidden = false;
    $('result-total').textContent = view.hasScore ? view.totalText : '—';
    if (view.gradeLabel) {
      $('result-grade').textContent = view.gradeLabel;
      $('result-grade').hidden = false;
    } else {
      $('result-grade').hidden = true;
    }
    $('result-dims').innerHTML = renderDims(view.dimensions);

    var calibRow = $('result-calibration-row');
    if (calibRow) {
      if (view.hasScore && root.ScoreCalibrator) {
        var dimMap = {};
        for (var di = 0; di < (view.dimensions || []).length; di++) {
          dimMap[view.dimensions[di].name] = Number(view.dimensions[di].scoreText) || 0;
        }
        var calibRes = root.ScoreCalibrator.calibrateScore({
          raw_total: Number(view.totalText) || 70,
          dimensions: dimMap,
          question_type: payload.questionType || '归纳概括',
          word_count: payload.answer ? countWords(payload.answer) : 400
        });
        if (calibRes) {
          calibRow.hidden = false;
          $('result-calibrated-score').textContent = calibRes.calibrated_score + ' 分';
          var badgeEl = $('result-consistency-badge');
          if (badgeEl) badgeEl.textContent = calibRes.reliability.badge;
        } else {
          calibRow.hidden = true;
        }
      } else {
        calibRow.hidden = true;
      }
    }

    $('result-meta').textContent = (payload.questionType ? payload.questionType + ' · ' : '') + formatTime(item.time);
    if (streaming) {
      $('result-status').textContent = '批改中…（每 0.3 秒刷新一次）';
    } else if (status === 'error') {
      $('result-status').textContent = '批改中断';
    } else if (text) {
      $('result-status').textContent = '批改完成';
    } else {
      $('result-status').textContent = '等待开始';
    }

    var errEl = $('result-error');
    if (payload.error) {
      errEl.hidden = false;
      errEl.textContent = payload.error;
      if (State.resultId === item.id) $('result-retry').hidden = false;
    } else {
      errEl.hidden = true;
      $('result-retry').hidden = !payload.question || !payload.answer;
    }

    // 正文块只在新文本到达时重解析（300ms 节流），避免空转
    if (changed) $('result-body').innerHTML = mdToHtml(text);

    renderIssues(view.issues);
    renderUpgrade(view.upgrade);
    renderPaper(payload);

    if (streaming) startResultPolling();
    else stopResultPolling();
  }

  function startResultPolling() {
    if (resultTimer) return;
    resultTimer = setInterval(function () {
      if (State.view !== 'result' || !State.gradeStream || State.gradeStream.recordId !== State.resultId) {
        stopResultPolling();
        if (State.view === 'result') {
          applyResultRecord(Store.getHistoryById(State.resultId));
        }
        return;
      }
      applyResultRecord(Store.getHistoryById(State.resultId));
    }, RENDER_THROTTLE);
  }

  function stopResultPolling() {
    if (resultTimer) {
      clearInterval(resultTimer);
      resultTimer = null;
    }
  }

  /** 五维分数条（分数越高越接近满分，用朱红；低于一半用金色以示提醒） */
  function renderDims(dims) {
    if (!dims || !dims.length) return '';
    var out = '';
    for (var i = 0; i < dims.length; i++) {
      var d = dims[i];
      out += '<div class="dim">' +
        '<div class="dim-head"><span>' + esc(d.name) + '</span><span class="' +
        (d.percent >= 60 ? 'gold' : '') + '">' + esc(d.scoreText) + ' / ' + d.max + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill' + (d.percent >= 60 ? '' : ' bar-fill-gold') +
        '" style="width:' + d.percent + '%"></div></div>' +
        (d.comment ? '<div class="dim-comment">' + esc(d.comment) + '</div>' : '') +
        '</div>';
    }
    return out;
  }

  /** 批注卡列表：引文 + 类型标签 + 问题 + 修改建议 */
  function renderIssues(issues) {
    var card = $('result-issues-card');
    var box = $('result-issues');
    if (!issues || !issues.length) {
      card.hidden = true;
      box.innerHTML = '';
      return;
    }
    card.hidden = false;
    var out = '';
    for (var i = 0; i < issues.length; i++) {
      var it = issues[i];
      out += '<div class="issue">' +
        (it.quote ? '<div class="issue-quote">' + esc(it.quote) + '</div>' : '') +
        (it.type ? '<div class="issue-line"><span class="tag ' + it.tagClass + '">' + esc(it.type) + '</span></div>' : '') +
        (it.comment ? '<div class="issue-line"><span class="issue-label">问题</span>' + esc(it.comment) + '</div>' : '') +
        (it.suggestion ? '<div class="issue-line"><span class="issue-label">建议</span>' + esc(it.suggestion) + '</div>' : '') +
        '</div>';
    }
    box.innerHTML = out;
  }

  /** 升格示范（scores.upgrade）：小程序的 result.wxml 有这一张卡，网站版不能丢 */
  function renderUpgrade(upgrade) {
    var card = $('result-upgrade-card');
    var box = $('result-upgrade');
    if (!upgrade) {
      card.hidden = true;
      box.textContent = '';
      return;
    }
    card.hidden = false;
    box.innerHTML = mdToHtml(upgrade);
  }

  function renderPaper(payload) {
    var card = $('result-paper-card');
    var box = $('result-paper');
    var parts = [];
    if (payload.question) parts.push('### 题目\n\n' + payload.question);
    if (payload.material) parts.push('### 给定资料\n\n' + payload.material);
    if (payload.referenceAnswer) parts.push('### 参考答案（用户提供）\n\n' + payload.referenceAnswer);
    if (payload.answer) parts.push('### 考生作答\n\n' + payload.answer);
    if (!parts.length) {
      card.hidden = true;
      box.innerHTML = '';
      return;
    }
    card.hidden = false;
    box.innerHTML = mdToHtml(parts.join('\n\n'));
  }

  /** 把 scores 对象整理成页面要的视图数据（与小程序版 buildScoreView 同构） */
  function buildScoreView(scores) {
    var out = { hasScore: false, totalText: '—', gradeLabel: '', dimensions: [], issues: [], upgrade: '' };
    if (!scores || typeof scores !== 'object') return out;
    if (scores.total == null || scores.total === '') return out;

    var dims = [];
    var sum = 0;
    var hasDims = false;
    var list = Array.isArray(scores.dimensions) ? scores.dimensions : [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i] || {};
      var name = String(d.name == null ? '' : d.name).trim() || ('维度' + (i + 1));
      var score = Number(d.score);
      if (!isFinite(score)) score = 0;
      var max = Number(d.max);
      if (!isFinite(max) || max <= 0) max = 100;
      sum += score;
      hasDims = true;
      dims.push({
        name: name,
        scoreText: formatScore(score),
        max: max,
        percent: Math.max(0, Math.min(100, Math.round((score / max) * 100))),
        comment: String(d.comment == null ? '' : d.comment)
      });
    }

    var total = Number(scores.total);
    if (!isFinite(total) && hasDims) total = sum;
    if (isFinite(total)) {
      out.totalText = String(Math.round(total * 10) / 10);
      out.hasScore = true;
    }
    out.gradeLabel = String(scores.grade == null ? '' : scores.grade).trim();
    out.dimensions = dims;

    var issues = Array.isArray(scores.issues) ? scores.issues : [];
    var view = [];
    for (var k = 0; k < issues.length; k++) {
      var it = issues[k] || {};
      var type = String(it.type == null ? '' : it.type).trim();
      view.push({
        quote: String(it.quote == null ? '' : it.quote),
        type: type,
        tagClass: ISSUE_TAG_CLASS[type] || 'tag-sub',
        comment: String(it.comment == null ? '' : it.comment),
        suggestion: String(it.suggestion == null ? '' : it.suggestion)
      });
    }
    out.issues = view;
    out.upgrade = String(scores.upgrade == null ? '' : scores.upgrade);
    return out;
  }

  function onResultCopy() {
    var item = Store.getHistoryById(State.resultId);
    var raw = (item && item.payload && item.payload.content) || '';
    var text = MD.stripScores(raw);
    if (!text.trim()) {
      toast('还没有可复制的内容');
      return;
    }
    copyText(text);
  }

  function onResultAgain() {
    stopResultPolling();
    finalizeOrphanStream(State.resultId);
    abortGradeStream();
    resetGradeForm();
    go('#/grade');
  }

  function resetGradeForm() {
    State.prefillAnchor = null; // 表单重置 → 共识锚点一并失效
    $('grade-question').value = '';
    $('grade-material').value = '';
    $('grade-reference').value = '';
    $('grade-answer').value = '';
    $('grade-scan-status').textContent = '';
    $('grade-scan-status').className = 'field-hint';
    updateLengthStandard();
    updateAnswerMeta();
  }

  function onResultRetry() {
    var item = Store.getHistoryById(State.resultId);
    if (!item) {
      toast('记录不存在了');
      return;
    }
    var payload = item.payload || {};
    var question = String(payload.question || '').trim();
    var answer = String(payload.answer || '').trim();
    if (!question || !answer) {
      toast('这条记录里没有完整的题目与作答，请回批改页重新提交');
      return;
    }
    var user = [
      '【题型】' + (payload.questionType || '归纳概括'),
      '【题目】' + question,
      '【给定资料】' + (payload.material ? payload.material : '（未提供）'),
      '【参考答案】' + (payload.referenceAnswer || '（未提供）'),
      '【考生作答】' + answer
    ].join('\n\n');
    if (payload.anchor && payload.anchor.block) {
      // 上次是共识锚点批改：重试沿用同一份程序核算块，要点完整度保持可复算
      user += '\n\n【共识锚点程序核算】\n' + payload.anchor.block;
    }
    var messages = [{ role: 'system', content: buildGradeSystem() }, { role: 'user', content: user }];

    stopResultPolling();
    resultLastText = '';
    var next = Store.getHistoryById(State.resultId);
    var p2 = next.payload || {};
    p2.content = '';
    p2.status = 'streaming';
    p2.error = '';
    Store.updateHistory(State.resultId, { payload: p2 });

    abortGradeStream();
    startGradeStream(State.resultId, messages);
    applyResultRecord(Store.getHistoryById(State.resultId));
  }

  // ================= 视图三：陪练 =================

  /** 陪练 system：COACH_PROMPT + SKILL_ROUTER + 按题注入的名师专题参考（照搬小程序版 chat.js） */
  function buildCoachSystem(latestText) {
    var base = Prompts.COACH_PROMPT + '\n\n' + Prompts.SKILL_ROUTER;
    var injected = pickReferences(String(latestText || ''));
    if (injected.length) {
      base += '\n\n【专题参考】以下内容仅供教学参考，题干材料和证据规则优先：\n\n' +
        injected.join('\n\n');
    }
    return base + '\n\n' + Prompts.QUALITY_RULES;
  }

  /**
   * 按用户最新消息挑选要注入的名师专题参考全文
   * @param {string} text
   * @returns {string[]} 命中的参考文本数组
   */
  function pickReferences(text) {
    var picked = [];
    var total = 0;
    if (!text) return picked;
    for (var i = 0; i < REF_ROUTES.length && picked.length < 3; i++) {
      var route = REF_ROUTES[i];
      if (!route.re.test(text)) continue;
      for (var j = 0; j < route.keys.length && picked.length < 3; j++) {
        var key = route.keys[j];
        if (picked.indexOf(key) !== -1) continue;
        var content = References.REF && References.REF[key];
        if (typeof content !== 'string' || !content) continue;
        if (total + content.length > REF_MAX_CHARS) continue;
        picked.push('—— 专题：' + key + ' ——\n' + content);
        total += content.length;
      }
    }
    return picked;
  }

  function mountChat(viewId) {
    if (!State.chat.chipsDone) {
      var chips = $('chat-chips');
      var html = '';
      for (var i = 0; i < QUICK_ASKS.length; i++) {
        html += '<button class="chip" type="button" data-ask="' + esc(QUICK_ASKS[i]) + '">' + esc(QUICK_ASKS[i]) + '</button>';
      }
      chips.innerHTML = html;
      State.chat.chipsDone = true;
    }
    refreshChatTip();
    if (viewId) {
      loadChatFromHistory(viewId);
    }
    // 无 viewId 时保持当前会话：切换视图再回来不会清空正在聊的内容
    renderChat();
  }

  function refreshChatTip() {
    var cfg = Store.getConfig();
    var tip = $('chat-mode-tip');
    if (tip) {
      tip.textContent = cfg.mode === 'server'
        ? '共享模型：已通过账号登录'
        : '自带 Key：' + (cfg.model || '未选模型');
    }
  }

  function makeMsg(role, text) {
    var time = Date.now();
    return { id: nextMsgId(), role: role, text: text, time: time, timeStr: formatTime(time) };
  }

  function loadChatFromHistory(id) {
    var record = Store.getHistoryById(id);
    if (!record || record.type !== 'chat') {
      toast('找不到这段对话记录');
      return;
    }
    var raw = (record.payload && record.payload.messages) || [];
    var messages = [];
    for (var i = 0; i < raw.length; i++) {
      var m = raw[i];
      if (!m || !m.content) continue;
      var time = m.time || record.time || Date.now();
      messages.push({
        id: nextMsgId(),
        role: m.role === 'user' ? 'user' : 'ai',
        text: String(m.content),
        time: time,
        timeStr: formatTime(time)
      });
    }
    State.chat.messages = messages;
    State.chat.readonly = true;
    State.chat.viewRecordId = id;
    State.chat.sending = false;
    State.chat.recordId = '';
    renderChat();
  }

  /** 取当前对话（不含 system），并按最近 HISTORY_TAIL 条截断 */
  function buildConversation() {
    var conv = [];
    for (var i = 0; i < State.chat.messages.length; i++) {
      var m = State.chat.messages[i];
      if (!m.text) continue;
      conv.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
    }
    if (conv.length > HISTORY_TAIL) conv = conv.slice(conv.length - HISTORY_TAIL);
    return conv;
  }

  function ensureChatRecord(firstText) {
    if (State.chat.recordId) return;
    var record = Store.addHistory({
      type: 'chat',
      title: brief(firstText, 18) || '解题对话',
      payload: { messages: [] }
    });
    State.chat.recordId = record.id;
  }

  function saveChatHistory() {
    if (State.chat.readonly) return;
    var msgs = State.chat.messages.filter(function (m) {
      return !!m.text;
    });
    if (!msgs.length) return;
    var payloadMessages = msgs.map(function (m) {
      return { role: m.role === 'user' ? 'user' : 'assistant', content: m.text, time: m.time };
    });
    var firstUser = '';
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user') {
        firstUser = msgs[i].text;
        break;
      }
    }
    var patch = {
      title: brief(firstUser, 18) || '解题对话',
      time: Date.now(),
      payload: { messages: payloadMessages }
    };
    if (State.chat.recordId) Store.updateHistory(State.chat.recordId, patch);
    else {
      var record = Store.addHistory({ type: 'chat', title: patch.title, payload: patch.payload });
      State.chat.recordId = record.id;
    }
  }

  function sendChat(rawText) {
    var text = String(rawText == null ? '' : rawText).trim();
    if (!text || State.chat.sending || State.chat.readonly) return;
    if (!Store.isConfigured()) {
      toast('还没有配置接入方式，请先到设置页设置');
      go('#/settings');
      return;
    }
    State.chat.messages.push(makeMsg('user', text));
    $('chat-input').value = '';
    hideChatError();
    ensureChatRecord(text);
    renderChat();

    var conversation = buildConversation();
    var latest = conversation.length ? conversation[conversation.length - 1].content : '';
    var messages = [{ role: 'system', content: buildCoachSystem(latest) }].concat(conversation);

    var aiMsg = makeMsg('ai', '');
    aiMsg.streaming = true;
    State.chat.aiMsgId = aiMsg.id;
    State.chat.buf = '';
    State.chat.lastRender = 0;
    State.chat.messages.push(aiMsg);
    State.chat.sending = true;
    renderChat();

    State.chat.task = Api.chatStream(Store.getConfig(), messages, {
      onDelta: function (delta) {
        if (!delta) return;
        State.chat.buf += delta;
        var now = Date.now();
        if (now - State.chat.lastRender < RENDER_THROTTLE) return;
        State.chat.lastRender = now;
        paintStreamingChat();
      },
      onDone: function (full) {
        var text2 = (typeof full === 'string' && full) ? full : State.chat.buf;
        applyChatFinal(text2, text2 ? '' : currentChatError());
      },
      onError: function (msg) {
        maybePromptCode(msg);
        showChatError(msg);
        // api 层可能正在自动降级重试：此时先不动气泡，等降级成功后的 onDone 收尾
      }
    });
    if (!State.chat.task) {
      // 配置不全：没有降级机会，立刻结束发送态
      applyChatFinal(State.chat.buf, currentChatError() || '请求未发出，请检查设置。');
    }
  }

  function currentChatError() {
    var el = $('chat-error');
    return el && !el.hidden ? el.textContent : '';
  }

  function paintStreamingChat() {
    var list = State.chat.messages;
    var last = list[list.length - 1];
    if (!last || last.id !== State.chat.aiMsgId) return;
    last.text = State.chat.buf;
    renderChat();
  }

  function applyChatFinal(fullText, error) {
    var list = State.chat.messages;
    var last = list[list.length - 1];
    if (last && last.id === State.chat.aiMsgId) {
      if (!last.text && !fullText) {
        list.pop(); // 空气泡没有意义，撤掉
      } else {
        last.text = fullText || last.text;
        last.streaming = false;
      }
    }
    State.chat.task = null;
    State.chat.sending = false;
    State.chat.buf = fullText || '';
    if (fullText) hideChatError();
    renderChat();
    saveChatHistory();
    if (error && !fullText) showChatError(error);
  }

  function showChatError(msg) {
    var el = $('chat-error');
    if (!el) return;
    el.textContent = msg || '请求失败，请稍后重试。';
    el.hidden = false;
  }

  function hideChatError() {
    var el = $('chat-error');
    if (el) el.hidden = true;
  }

  /** 重试：撤掉上一轮 AI 回复，用同一批上下文再问一次 */
  function retryChat() {
    if (State.chat.sending || State.chat.readonly) return;
    var list = State.chat.messages;
    while (list.length && list[list.length - 1].role === 'ai') list.pop();
    hideChatError();
    var last = list[list.length - 1];
    renderChat();
    if (last && last.text) requestChatAnswer();
  }

  /** 只发起一次请求（不追加用户消息） */
  function requestChatAnswer() {
    var conversation = buildConversation();
    var latest = conversation.length ? conversation[conversation.length - 1].content : '';
    var messages = [{ role: 'system', content: buildCoachSystem(latest) }].concat(conversation);

    var aiMsg = makeMsg('ai', '');
    aiMsg.streaming = true;
    State.chat.aiMsgId = aiMsg.id;
    State.chat.buf = '';
    State.chat.lastRender = 0;
    State.chat.messages.push(aiMsg);
    State.chat.sending = true;
    renderChat();

    var hadError = false;
    State.chat.task = Api.chatStream(Store.getConfig(), messages, {
      onDelta: function (delta) {
        if (!delta) return;
        if (hadError) {
          State.chat.buf = delta;
        } else {
          State.chat.buf += delta;
        }
        var now = Date.now();
        if (now - State.chat.lastRender < RENDER_THROTTLE) return;
        State.chat.lastRender = now;
        paintStreamingChat();
      },
      onReplace: function (full) {
        State.chat.buf = full || '';
        paintStreamingChat();
      },
      onDone: function (full) {
        applyChatFinal((typeof full === 'string' && full) ? full : State.chat.buf, '');
      },
      onError: function (msg) {
        hadError = true;
        maybePromptCode(msg);
        showChatError(msg);
      }
    });
    if (!State.chat.task) applyChatFinal(State.chat.buf, '请求未发出，请检查设置。');
  }

  /** 退出只读回看，继续在这段对话上聊（仍写回同一条历史记录） */
  function continueChat() {
    State.chat.recordId = State.chat.viewRecordId;
    State.chat.readonly = false;
    State.chat.viewRecordId = '';
    renderChat();
  }

  function newChat() {
    if (State.chat.sending) abortChat();
    saveChatHistory();
    State.chat.messages = [];
    State.chat.buf = '';
    State.chat.aiMsgId = '';
    State.chat.recordId = '';
    State.chat.lastRender = 0;
    State.chat.sending = false;
    State.chat.readonly = false;
    State.chat.viewRecordId = '';
    hideChatError();
    renderChat();
    toast('已开始新的对话');
  }

  function abortChat() {
    if (State.chat.task && typeof State.chat.task.abort === 'function') {
      try {
        State.chat.task.abort();
      } catch (e) { /* 忽略 */ }
    }
    State.chat.task = null;
    State.chat.sending = false;
  }

  function renderChat() {
    var box = $('chat-list');
    var chips = $('chat-chips-card');
    if (!box) return;
    var msgs = State.chat.messages;
    if (!msgs.length) {
      box.innerHTML = '<div class="card"><div class="empty">还没有对话。点上面的快捷指令，或在下面直接问一句。</div></div>';
      updateChatSendUI();
      return;
    }
    var html = '';
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var isUser = m.role === 'user';
      var body = isUser ? esc(m.text) : mdToHtml(m.text);
      if (!isUser && m.streaming && m.text) body += '<span class="cursor"></span>';
      if (!isUser && m.streaming && !m.text) body += '<span class="muted">正在思考…</span>';
      html += '<div class="bubble ' + (isUser ? 'bubble-user' : 'bubble-ai') + '">' +
        '<div class="bubble-body">' +
        '<div class="bubble-time">' + esc(m.timeStr) + '</div>' + body +
        '</div></div>';
    }
    if (State.chat.readonly) {
      html += '<div class="card"><div class="row gap">' +
        '<button class="btn-ghost btn-sm" id="chat-continue" type="button">继续这段对话</button>' +
        '</div><p class="field-hint">当前是历史回看模式，只读。</p></div>';
    }
    html += '<div class="card"><button class="btn-ghost btn-sm" id="chat-retry" type="button">重试上一轮</button></div>';
    box.innerHTML = html;
    var cont = $('chat-continue');
    if (cont) cont.onclick = continueChat;
    var retry = $('chat-retry');
    if (retry) retry.onclick = retryChat;
    if (chips) chips.hidden = false;
    updateChatSendUI();
    root.scrollTo(0, doc.body.scrollHeight);
  }

  function updateChatSendUI() {
    var send = $('chat-send');
    var input = $('chat-input');
    if (send) {
      send.disabled = State.chat.sending || State.chat.readonly;
      send.textContent = State.chat.sending ? '发送中' : '发送';
    }
    if (input) input.disabled = State.chat.readonly;
  }

  // ================= 视图四：真题 =================

  function mountPapers() {
    var box = $('papers-list');
    var list = (Papers && Papers.PAPERS) || [];
    var totalQ = 0;
    var i2;
    for (i2 = 0; i2 < list.length; i2++) {
      totalQ += ((list[i2].questions || []).length);
    }
    var html = '<div class="intro-title">内置改编练习（非原卷）</div>' +
      '<p class="field-hint mb">共 ' + list.length + ' 套、' + totalQ +
      ' 题，题干与材料为按真题考向整理的摘要版，供日常练习用。</p>';
    for (var i = 0; i < list.length; i++) {
      var paper = list[i];
      var open = !!State.openPapers[paper.id];
      var qs = paper.questions || [];
      html += '<div class="paper-item">' +
        '<div class="paper-head" data-paper="' + esc(paper.id) + '">' +
        '<div class="flex-1">' +
        '<div class="paper-title">' + esc(paper.title) + '</div>' +
        '<div class="muted">' + esc(paper.year || '') + ' 年 · ' + qs.length + ' 题</div>' +
        '</div>' +
        '<span class="muted">' + (open ? '收起' : '展开') + '</span></div>';
      if (open) {
        html += '<div class="paper-body">';
        if (paper.note) html += '<p class="field-hint">' + esc(paper.note) + '</p>';
        for (var j = 0; j < qs.length; j++) {
          var q = qs[j];
          html += '<div class="q-item">' +
            '<div class="q-title">第 ' + (j + 1) + ' 题 · ' + esc(q.type) + '</div>' +
            '<div class="q-text">' + esc(q.question) + '</div>';
          if (q.material) {
            html += '<div class="muted mt-s">材料摘要（' + countWords(q.material) + ' 字）</div>' +
              '<details class="mt-s"><summary class="muted">展开材料</summary>' +
              '<div class="q-text mt-s">' + esc(q.material).replace(/\n/g, '<br>') + '</div></details>';
          }
          if (q.keypoints && q.keypoints.length) {
            html += '<div class="keys">' +
              '<span class="key">' + esc(q.keypoints.join('；')) + '</span></div>';
          }
          html += '<div class="row gap mt-s"><button class="btn-ghost btn-sm" type="button" data-answer="' +
            esc(q.id) + '">去作答</button></div></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    if (!list.length) html = '<div class="empty">题库为空，请先执行 node tools/build-site.js 生成题库。</div>';
    box.innerHTML = html;
    mountPaperCatalog(box);
  }

  function mountPaperCatalog(box) {
    var catalog = window.PaperCatalog;
    if (!catalog || !catalog.papers || !catalog.papers.length) return;
    var panel = document.createElement('div');
    var regions = catalog.papers.map(function(p){return p.region;}).filter(function(r,i,a){return a.indexOf(r)===i;}).sort(function(a,b){return a.localeCompare(b,'zh');});
    var visibleLimit = 80;
    panel.className = 'mt';
    panel.innerHTML = '<div class="intro-title">2020—2026 真题来源目录</div>' +
      '<p class="field-hint">已收录 ' + catalog.papers.length + ' 条来源；其中 <b>' + Object.keys(root.PapersFullIndex||{}).length + ' 卷已导入全文</b>，可直接选题预填批改（含材料；标注「含参考答案」的会自动带非官方机构解析）。回忆版以来源标注为准。</p>' +
      '<div class="row gap"><select aria-label="真题年份" id="catalog-year"><option value="">全部年份</option>' +
      [2026,2025,2024,2023,2022,2021,2020].map(function(y){return '<option>'+y+'</option>';}).join('') +
      '</select><select aria-label="真题省份" id="catalog-region" style="min-width:0;flex:1"><option value="">全部地区</option>'+regions.map(function(r){return '<option>'+esc(r)+'</option>';}).join('')+'</select></div>' +
      '<input class="input-box mt-s" id="catalog-search" aria-label="搜索地区卷别" placeholder="搜索卷别、关键词">' +
      '<p id="catalog-coverage" class="field-hint"></p>' +
      '<div id="catalog-results"></div>';
    box.insertBefore(panel, box.firstChild);
    function render() {
      var year = panel.querySelector('#catalog-year').value;
      var term = panel.querySelector('#catalog-search').value.trim();
      var region = panel.querySelector('#catalog-region').value;
      var regionRows = catalog.papers.filter(function(p){return !region || p.region===region;});
      panel.querySelector('#catalog-coverage').textContent = (region || '全部地区')+'逐年来源数量：'+[2020,2021,2022,2023,2024,2025,2026].map(function(y){var n=regionRows.filter(function(p){return p.year===y;}).length;return y+'：'+(n?n+'卷':'未收录');}).join('；')+'。有记录不代表卷别齐全。';
      var rows = regionRows.filter(function(p){return (!year || String(p.year) === year) && (!term || (p.title+p.region).indexOf(term)!==-1);});
      var fullIndex = root.PapersFullIndex || {};
      panel.querySelector('#catalog-results').innerHTML = '<p class="muted">匹配 '+rows.length+' 卷，显示 '+Math.min(visibleLimit,rows.length)+' 卷</p>' + rows.slice(0,visibleLimit).map(function(p){
        var answerLinks=(p.answerSources||[]).map(function(a){return '<p class="mt-s"><a target="_blank" rel="noopener noreferrer" href="'+esc(a.url)+'">'+esc(a.title)+'</a><br><span class="field-hint">'+esc(a.kind)+'；'+esc(a.availability)+'</span></p>';}).join('');
        var full = fullIndex[p.id];
        var actions = '<a class="btn-ghost btn-sm" target="_blank" rel="noopener noreferrer" href="'+esc(p.sourceUrl)+'">打开试卷来源</a>';
        if (full && full.qs && full.qs.length) {
          actions += ' <button class="btn-ghost btn-sm" type="button" data-pick="'+esc(p.id)+'">选题作答（'+full.qs.length+'题'+(full.ap?'·含参考答案':'')+'）</button>';
        }
        return '<div class="q-item"><div class="q-title">'+esc(p.title)+'</div><p class="muted">'+esc(p.region)+' · 来源目录'+(p.recalled?' · 考生回忆版':'')+(full?' · 已导入全文':'')+'</p>'+actions+'<div class="paper-question-list" id="pick-'+esc(p.id)+'"></div>'+answerLinks+'</div>';
      }).join('') + (rows.length>visibleLimit?'<button id="catalog-more" class="btn-ghost" type="button">继续显示后面的试卷</button>':'');
      var more=panel.querySelector('#catalog-more');
      if(more) more.addEventListener('click',function(){visibleLimit+=80;render();});
      box = panel;
      panel.querySelectorAll('button[data-pick]').forEach(function(btn){
        btn.addEventListener('click',function(){ togglePaperQuestions(panel, btn.getAttribute('data-pick')); });
      });
    }
    function filterChanged(){visibleLimit=80;render();}
    panel.querySelector('#catalog-year').addEventListener('change',filterChanged);
    panel.querySelector('#catalog-region').addEventListener('change',filterChanged);
    panel.querySelector('#catalog-search').addEventListener('input',filterChanged);
    render();
  }

  /** 卷子选题作答：展开题目列表（依赖 PapersFullIndex 懒加载全文与参考答案） */
  function togglePaperQuestions(panel, paperId) {
    var box = panel.querySelector('#pick-' + paperId);
    if (!box) return;
    if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; return; }
    var meta = (root.PapersFullIndex || {})[paperId];
    if (!meta || !meta.qs || !meta.qs.length) { toast('该卷还没有导入全文'); return; }
    box.dataset.open = '1';
    box.innerHTML = meta.qs.map(function(q, i) {
      return '<div class="q-item mt-s" style="padding:.5rem .6rem;">' +
        '<div class="q-title" style="font-size:.86rem;">第' + esc(q.no) + '题' + (q.score ? '（' + q.score + '分）' : '') + ' · ' + esc(q.type || '归纳概括') + '</div>' +
        '<p class="field-hint">' + esc(String(q.stem || '').slice(0, 90)) + (String(q.stem || '').length > 90 ? '……' : '') + '</p>' +
        '<button class="btn-ghost btn-sm" type="button" data-prefill="' + esc(paperId) + '|' + i + '">预填到批改' + (q.ap || meta.ap ? '（含参考答案）' : '') + '</button>' +
        '</div>';
    }).join('');
    box.querySelectorAll('button[data-prefill]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var parts = btn.getAttribute('data-prefill').split('|');
        prefillFromPaperQuestion(parts[0], Number(parts[1]));
      });
    });
  }

  function normalizeQuestionNo(no) {
    var s = String(no == null ? '' : no).trim();
    var cn = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
    if (cn[s]) return cn[s];
    var m = s.match(/\d+/);
    return m ? String(Number(m[0])) : s;
  }

  function stemSim(a, b) {
    // overlap coefficient on character bigrams — good enough to spot the same question
    var sa = String(a || ''), sb = String(b || '');
    if (sa.length < 6 || sb.length < 6) return 0;
    var setA = {}, nA = 0;
    for (var i = 0; i < sa.length - 1; i++) { setA[sa.substr(i, 2)] = 1; nA++; }
    var hit = 0, nB = 0;
    for (var j = 0; j < sb.length - 1; j++) { var g = sb.substr(j, 2); nB++; if (setA[g]) hit++; }
    return nA && nB ? hit / Math.min(nA, nB) : 0;
  }

  /** 全量卷子包：单文件 gzip，浏览器解压后按 id 取用（部署体积小、请求少） */
  var __papersBundlePromise = null;
  function loadPapersBundle() {
    if (root.__papersBundle) return Promise.resolve(root.__papersBundle);
    if (__papersBundlePromise) return __papersBundlePromise;
    __papersBundlePromise = root.fetch('js/vendor/papers-bundle.json.gz')
      .then(function(res) {
        if (!res.ok) throw new Error('bundle http ' + res.status);
        if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
        var ds = new DecompressionStream('gzip');
        var stream = res.body.pipeThrough(ds);
        return new Response(stream).text();
      })
      .then(function(text) {
        root.__papersBundle = JSON.parse(text);
        return root.__papersBundle;
      })
      .catch(function(e) {
        __papersBundlePromise = null;
        throw e;
      });
    return __papersBundlePromise;
  }

  /** 把真题题干+对应材料+非官方参考答案预填进批改表单 */
  function prefillFromPaperQuestion(paperId, questionIndex) {
    var meta = (root.PapersFullIndex || {})[paperId];
    if (!meta || !meta.qs || !meta.qs[questionIndex]) { toast('没有这道题'); return; }
    var q = meta.qs[questionIndex];
    var docPromise = loadPapersBundle()
      .then(function(bundle) { return bundle[paperId] || null; })
      .catch(function() {
        // 回退：逐卷文件（本地开发环境仍可用）
        return root.fetch('js/vendor/papers/' + paperId + '.json').then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
      });
    Promise.all([
      docPromise,
      root.fetch('js/vendor/consensus-points/' + paperId + '.json').then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
      root.fetch('js/vendor/answer-points/' + paperId + '.json').then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; })
    ]).then(function(res) {
      var doc = res[0], cons = res[1], pts = res[2];
      if (!doc) { toast('全文数据缺失，请重新执行 node tools/sync-site-papers.js'); return; }
      var target = null;
      var qNo = normalizeQuestionNo(q.no);
      (doc.questions || []).forEach(function(dq) {
        if (!target && normalizeQuestionNo(dq.no) === qNo) target = dq;
      });
      var stem = (target && target.stem) || q.stem;
      // 材料：按题目范围取，取不到就给全卷
      var range = q.mr || '';
      var mNo = range ? normalizeQuestionNo(range.replace(/[^0-9一二三四五六七八九十]/g, '')) : '';
      var materials = (doc.materials || []).filter(function(m) { return !mNo || normalizeQuestionNo(m.no) === mNo; });
      if (!materials.length) materials = doc.materials || [];
      var materialText = materials.map(function(m) { return '材料' + m.no + '\n' + m.text; }).join('\n\n');
      // 参考答案（非官方）：优先用共识对齐组（核心点权重高），否则回退到逐机构要点；
      // 同题多记录按题干相似度+分值一致选最优
      var reference = '';
      var pq = null;
      var anchorGroups = null;
      var anchorScore = null;
      if (cons) {
        var ccands = (cons.questions || []).filter(function(cq) { return normalizeQuestionNo(cq.no) === qNo; });
        ccands.sort(function(a, b) {
          var d = stemSim(b.stem, stem) - stemSim(a.stem, stem);
          if (Math.abs(d) > 0.15) return d;
          var sa = a.score && q.score ? Math.abs(a.score - q.score) : (a.score ? 5 : 0);
          var sb = b.score && q.score ? Math.abs(b.score - q.score) : (b.score ? 5 : 0);
          return sa - sb;
        });
        var cq = ccands[0];
        if (cq && cq.groups && cq.groups.length) {
          // 闭环可复算覆盖率的锚点原料：分组权重（count/level）交给覆盖率程序，页面只负责搬运
          anchorGroups = cq.groups.map(function (g) {
            return { text: g.text, count: g.count, level: g.level };
          });
          anchorScore = Number(q.score || cq.score) || null;
          var core = cq.groups.filter(function(g){ return g.level === 'core'; });
          var single = cq.groups.filter(function(g){ return g.level !== 'core'; });
          var parts = [];
          if (core.length) parts.push('【共识要点 · ' + core[0].count + '家机构都写 · 漏写影响大】\n' + core.map(function(g, i){ return (i+1) + '. ' + g.text; }).join('\n'));
          if (single.length) parts.push('【单源要点 · 仅1家 · 仅供参考，漏写不必慌】\n' + single.map(function(g, i){ return (i+1) + '. ' + g.text; }).join('\n'));
          if (parts.length) {
            parts.push('【批改要求（本题有共识锚点）】\n先逐条判定考生对上述要点的命中：完整命中/部分命中/语义偏差/未写（同义改写、合并陈述都算命中）。要点完整度按共识度加权核对覆盖给出——共识要点权重高，漏写或写偏如实扣；单源要点权重低，漏写不重罚。不要凭整体印象估要点分。');
            reference = '来源：知乎公开解析·多机构对齐（非官方答案，仅供学习比对）\n\n' + parts.join('\n\n');
          }
        }
      }
      if (!reference && pts) {
        var candidates = (pts.questions || []).filter(function(pq2) { return normalizeQuestionNo(pq2.no) === qNo; });
        candidates.sort(function(a, b) {
          var d = stemSim(b.stem, stem) - stemSim(a.stem, stem);
          if (Math.abs(d) > 0.15) return d;
          var sa = a.score && q.score ? Math.abs(a.score - q.score) : (a.score ? 5 : 0);
          var sb = b.score && q.score ? Math.abs(b.score - q.score) : (b.score ? 5 : 0);
          return sa - sb;
        });
        var pq = candidates[0];
        if (pq) {
          var sections = (pq.institutionAnswers || []).map(function(ia) {
            return '【' + (ia.name || '未标注来源') + '】\n' + (ia.points || []).map(function(p2, i2) { return (i2 + 1) + '. ' + p2; }).join('\n');
          });
          if (pq.rubric) sections.unshift('【评分标准（来源标注，非官方发布）】\n' + pq.rubric);
          if (sections.length) {
            reference = '来源：知乎公开解析（非官方答案，仅供学习比对）\n\n' + sections.join('\n\n');
          }
        }
      }
      resetGradeForm();
      var typeEl = $('grade-type');
      if (typeEl) typeEl.value = q.type || '归纳概括';
      $('grade-question').value = (meta.t ? '【' + meta.t + '】' : '') + stem;
      updateLengthStandard();
      $('grade-material').value = materialText;
      $('grade-reference').value = reference;
      // 捕获共识锚点：提交时题干与 questionValue 一致才启用两阶段（改题即回退单阶段）
      State.prefillAnchor = (anchorGroups && anchorGroups.length) ? {
        paperId: paperId,
        qNo: qNo,
        stem: stem,
        questionValue: (meta.t ? '【' + meta.t + '】' : '') + stem,
        groups: anchorGroups,
        questionScore: anchorScore
      } : null;
      go('#/grade');
      toast('已预填：第' + q.no + '题' + (reference ? '（含非官方参考答案）' : '（本卷暂无可读参考答案）'));
    }).catch(function() { toast('加载数据失败'); });
  }

  /** 真题「去作答」：把题目与材料预填进批改表单再跳转（与小程序版一致） */
  function prefillFromPapers(id) {
    var found = (Papers && Papers.getQuestionById) ? Papers.getQuestionById(id) : null;
    if (!found) {
      toast('题库里没有这道题');
      return;
    }
    resetGradeForm();
    var typeEl = $('grade-type');
    if (typeEl && found.question.type) typeEl.value = found.question.type;
    $('grade-question').value = found.question.question || '';
    updateLengthStandard();
    $('grade-material').value = found.question.material || '';
    $('grade-reference').value = found.question.referenceAnswer || '';
    go('#/grade');
    toast('已预填：' + (found.paper ? found.paper.title : '真题'));
  }

  // ================= 视图五：备考 =================

  function mountStudy() {
    var level = $('study-level');
    var hours = $('study-hours');
    var target = $('study-target');
    var weeks = $('study-weeks');
    if (level && !level.options.length) fillSelect(level, LEVELS, LEVELS[1]);
    if (hours && !hours.options.length) fillSelect(hours, DAILY_LABELS, DAILY_LABELS[1]);
    if (target && !target.options.length) fillSelect(target, TARGETS, TARGETS[0]);
    if (weeks && !weeks.options.length) fillSelect(weeks, WEEK_OPTIONS, WEEK_OPTIONS[1]);

    var plan = Store.getPlan();
    var card = $('study-plan-card');
    hideStudyError();
    if (plan.content) {
      card.hidden = false;
      $('study-plan').innerHTML = mdToHtml(plan.content);
      renderCheckins(plan);
    } else {
      card.hidden = true;
      $('study-plan').innerHTML = '';
      $('study-checkins').innerHTML = '';
      $('study-status').textContent = '';
    }
  }

  function showStudyError(msg) {
    var card = $('study-error-card');
    $('study-error').textContent = msg || '生成失败，请稍后重试。';
    card.hidden = false;
  }

  function hideStudyError() {
    var card = $('study-error-card');
    if (card) card.hidden = true;
  }

  function renderCheckins(plan) {
    var box = $('study-checkins');
    var weeks = guessWeeks(plan.content, plan.form);
    if (!weeks) {
      box.innerHTML = '<p class="field-hint">生成计划后，这里会按周出现打卡格子。</p>';
      return;
    }
    var done = 0;
    for (var w = 1; w <= weeks; w++) {
      if (plan.checkins && plan.checkins[w]) done++;
    }
    var html = '<div class="row-between mb"><span class="muted">已完成 ' + done + ' / ' + weeks + ' 周</span>' +
      '<span class="muted">共 ' + weeks + ' 周</span></div>' +
      '<div class="bar-track progress-track"><div class="bar-fill" style="width:' +
      (weeks ? Math.round((done * 100) / weeks) : 0) + '%"></div></div>' +
      '<div class="checkin-grid">';
    for (var i = 1; i <= weeks; i++) {
      html += '<button class="checkin-cell' + ((plan.checkins && plan.checkins[i]) ? ' done' : '') +
        '" type="button" data-week="' + i + '">第' + i + '周</button>';
    }
    html += '</div>';
    box.innerHTML = html;
  }

  /** 从计划正文里数出「第X周」标题；数不出就按表单里选的周数 */
  function guessWeeks(content, form) {
    var m = String(content || '').match(/第\s*(\d+)\s*周/g);
    if (m && m.length) {
      var max = 0;
      for (var i = 0; i < m.length; i++) {
        var n = parseInt(m[i].replace(/\D/g, ''), 10);
        if (n > max && n <= MAX_WEEKS) max = n;
      }
      if (max > 0) return max;
    }
    if (form && form.weeks) {
      var w = parseInt(String(form.weeks).replace(/\D/g, ''), 10);
      if (isFinite(w) && w > 0 && w <= MAX_WEEKS) return w;
    }
    return 0;
  }

  function onStudySubmit() {
    var form = {
      level: $('study-level').value,
      hours: $('study-hours').value,
      target: $('study-target').value,
      weeks: $('study-weeks').value
    };
    if (!Store.isConfigured()) {
      toast('还没有配置接入方式，请先到设置页设置');
      go('#/settings');
      return;
    }
    Store.setPlan({ form: form });
    var user = [
      '【基础水平】' + form.level,
      '【每日可用时长】' + form.hours,
      '【目标岗位】' + form.target,
      '【距离考试】' + form.weeks,
      '',
      '请据此生成我的申论备考计划。'
    ].join('\n');
    var system = Prompts.COACH_PROMPT + '\n\n' + PLAN_INSTRUCTION;

    State.study.buf = '';
    State.study.lastRender = 0;
    $('study-status').className = 'field-hint';
    $('study-status').textContent = '正在生成…';
    hideStudyError();
    $('study-plan-card').hidden = false;
    $('study-plan').innerHTML = '';
    $('study-checkins').innerHTML = '';
    $('study-submit').disabled = true;

    if (State.study.task && typeof State.study.task.abort === 'function') {
      try {
        State.study.task.abort();
      } catch (e) { /* 忽略 */ }
    }

    var hadError = false;
    State.study.task = Api.chatStream(Store.getConfig(), [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], {
      onDelta: function (delta) {
        if (!delta) return;
        hideStudyError(); // 降级成功时也会走 onDelta（一次性吐全文），撤下错误卡
        if (hadError) {
          State.study.buf = delta;
        } else {
          State.study.buf += delta;
        }
        var now = Date.now();
        if (now - State.study.lastRender < RENDER_THROTTLE) return;
        State.study.lastRender = now;
        $('study-plan').innerHTML = mdToHtml(State.study.buf);
      },
      onReplace: function (full) {
        hideStudyError();
        State.study.buf = full || '';
        $('study-plan').innerHTML = mdToHtml(State.study.buf);
      },
      onDone: function (full) {
        var text = (typeof full === 'string' && full) ? full : State.study.buf;
        State.study.task = null;
        $('study-submit').disabled = false;
        $('study-status').className = 'field-hint';
        $('study-status').textContent = '计划已生成，可按周打卡。';
        hideStudyError();
        Store.setPlan({ content: text });
        $('study-plan').innerHTML = mdToHtml(text);
        renderCheckins(Store.getPlan());
      },
      onError: function (msg) {
        hadError = true;
        maybePromptCode(msg);
        $('study-status').className = 'field-hint';
        $('study-status').textContent = '流式请求异常，尝试自动降级中…';
        showStudyError(msg);
      }
    });
    if (!State.study.task) {
      $('study-submit').disabled = false;
      $('study-status').textContent = '请求未发出，请检查设置。';
    }
  }

  /** 备考页的错误卡：重试 = 用当前表单再生成一次；去设置 = 跳设置页 */
  function onStudyRetry() {
    if (!Store.isConfigured()) {
      toast('还没有配置接入方式，请先到设置页设置');
      go('#/settings');
      return;
    }
    onStudySubmit();
  }

  // ================= 视图六：历史 =================

  function mountHistory() {
    var list = Store.filterHistory(State.historyFilter);
    var box = $('history-list');
    if (!list.length) {
      box.innerHTML = '<div class="empty">还没有记录。批改一篇或聊一轮就会出现在这里，最多保留 50 条。</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var payload = it.payload || {};
      var extra = '';
      if (it.type === 'grade') {
        var sc = payload.scores || MD.parseScores(payload.content || '');
        if (sc && isFinite(Number(sc.total))) extra = ' · ' + Math.round(Number(sc.total)) + ' 分';
        if (payload.status === 'streaming') extra = ' · 批改中';
        else if (payload.status === 'error') extra = ' · 已中断';
      } else {
        var msgs = payload.messages || [];
        extra = ' · ' + msgs.length + ' 条';
      }
      html += '<div class="history-item" data-history="' + esc(it.id) + '">' +
        '<div class="history-title">' + esc(it.title) + '</div>' +
        '<div class="history-meta">' +
        '<span class="tag">' + (it.type === 'chat' ? '对话' : '批改') + '</span>' +
        '<span>' + esc(fromNow(it.time)) + '</span>' + '<span>' + extra + '</span>' +
        '<button class="btn-ghost btn-sm history-del" type="button" data-del="' + esc(it.id) + '">删除</button>' +
        '</div></div>';
    }
    box.innerHTML = html;
  }

  function openHistoryItem(id) {
    var item = Store.getHistoryById(id);
    if (!item) {
      toast('记录不存在了');
      return;
    }
    if (item.type === 'chat') go('#/chat?id=' + encodeURIComponent(id));
    else go('#/result?id=' + encodeURIComponent(id));
  }

  // ================= 视图七：设置 =================

  function mountSettings() {
    var cfg = Store.getConfig();
    $('settings-official-enable').hidden = !/^(localhost|127\.0\.0\.1)$/.test(root.location.hostname) || cfg.mode !== 'selfkey';
    $('settings-guide-card').hidden = cfg.mode !== 'selfkey';
    root.fetch('/api/health').then(function (res) { return res.json(); }).then(function (info) {
      $('settings-official-title').textContent = info.sharedReady ? (info.officialModel || Api.SERVER_DEFAULT_MODEL) : '共享模型未连接';
      $('settings-official-description').textContent = info.sharedProvider === 'opencode-go'
        ? '由站主电脑上的 OpenCode Go 提供，仅支持文本；电脑、OpenCode 和桥接服务关闭时不可用。'
        : '共享模型由站主配置的服务端密钥提供；登录账号后即可使用。';
      $('settings-official-status').textContent = info.sharedReady
        ? '已启用 · ' + info.officialModel + (info.sharedProvider === 'opencode-go' ? ' · 本机 OpenCode 桥接' : ' · 服务端模型')
        : '共享服务尚未配置。';
      if (cfg.mode === 'server') $('settings-mode-hint').textContent = info.sharedReady
        ? '共享模型：' + info.officialModel + '。已通过账号登录，请求由站主服务器转发。'
        : '共享模型尚未连接，请稍后再试或切换到自带 Key 模式。';
    }).catch(function () { $('settings-official-status').textContent = '暂时无法连接共享服务'; });

    var modeBtns = doc.querySelectorAll('#settings-mode .chip');
    for (var i = 0; i < modeBtns.length; i++) {
      var m = modeBtns[i].getAttribute('data-mode');
      modeBtns[i].className = (m === cfg.mode) ? 'chip chip-active' : 'chip';
    }
    if (cfg.mode !== 'server') $('settings-mode-hint').textContent =
      '自带 Key 模式：填自己的 API Key，请求经服务器纯转发，服务器不保存你的密钥。';

    $('settings-selfkey').hidden = cfg.mode !== 'selfkey';

    if (cfg.mode === 'selfkey') {
      var curPreset = Api.getPreset(cfg.presetId) || Api.PRESETS[0];
      renderPresetGrid(cfg);
      $('settings-baseurl').value = cfg.baseURL;
      $('settings-apikey').value = cfg.apiKey;
      renderModelSelect($('settings-model'), $('settings-model-custom'), curPreset.models, cfg.model);
      renderVisionSelect($('settings-vision'), $('settings-vision-custom'), curPreset, cfg.visionModel);
      $('settings-preset-doc').textContent = curPreset.doc || '';
    }

    renderModelGuide(cfg);

    var meta = $('settings-skill-meta');
    if (meta && Prompts.SKILL_META) {
      meta.textContent = '内置 Skill：' + Prompts.SKILL_META.name + ' v' + Prompts.SKILL_VERSION +
        '；' + Prompts.SKILL_META.summary;
    }
  }

  /**
   * 推荐模型方案：按上手难度列出推荐厂商，一键切到自带 Key 模式并填好地址与模型。
   * directOk=false 的厂商在「本地文件打开」时无法直连（CORS 限制），标注需转发。
   */
  function renderModelGuide(cfg) {
    var box = $('settings-guide');
    if (!box) return;
    var order = ['zhipu', 'deepseek', 'qwen', 'moonshot', 'openai', 'custom'];
    var current = (cfg && cfg.presetId) || '';
    var html = '';
    for (var i = 0; i < order.length; i++) {
      var p = Api.getPreset(order[i]);
      if (!p) continue;
      var isCur = cfg && cfg.mode === 'selfkey' && current === p.id;
      html += '<div class="guide-row">' +
        '<div class="guide-head">' +
        '<span class="guide-name">' + esc(p.name) + '</span>' +
        (p.directOk
          ? '<span class="tag tag-ok">手机直连可用</span>'
          : '<span class="tag">需转发模式</span>') +
        (isCur ? '<span class="tag tag-gold">当前使用</span>' : '') +
        '</div>' +
        '<p class="field-hint">' + esc(p.tagline || p.doc || '') + '</p>' +
        '<div class="row gap">' +
        '<button class="btn-ghost btn-sm" type="button" data-guide="' + esc(p.id) + '">一键配置</button>' +
        (p.applyUrl
          ? '<a class="btn-ghost btn-sm" href="' + esc(p.applyUrl) + '" target="_blank" rel="noopener">申请 Key</a>'
          : '') +
        '</div></div>';
    }
    box.innerHTML = html;
  }

  /** 厂商预设六宫格 */
  function renderPresetGrid(cfg) {
    var box = $('settings-presets');
    var html = '';
    for (var i = 0; i < Api.PRESETS.length; i++) {
      var p = Api.PRESETS[i];
      html += '<button class="preset-cell' + (p.id === cfg.presetId ? ' active' : '') +
        '" type="button" data-preset="' + esc(p.id) + '">' + esc(p.name) + '</button>';
    }
    box.innerHTML = html;
  }

  /** 主模型下拉：候选项 + 「手输自定义」 */
  function renderModelSelect(selectEl, inputEl, models, current) {
    if (!selectEl) return;
    var list = (models || []).slice();
    var CUSTOM = '手输自定义';
    var value = String(current || '').trim();
    var idx = list.indexOf(value);
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<option value="' + esc(list[i]) + '">' + esc(list[i]) + '</option>';
    }
    html += '<option value="' + CUSTOM + '">' + CUSTOM + '</option>';
    selectEl.innerHTML = html;
    selectEl.value = idx >= 0 ? list[idx] : CUSTOM;
    inputEl.hidden = selectEl.value !== CUSTOM;
    if (selectEl.value === CUSTOM && value) inputEl.value = value;
  }

  /** 视觉模型下拉：候选项来自预设 visionModels + 手输 */
  function renderVisionSelect(selectEl, inputEl, preset, current) {
    if (!selectEl) return;
    var list = (preset && preset.visionModels) ? preset.visionModels.slice() : [];
    var CUSTOM = '手输自定义';
    var value = String(current || '').trim();
    var idx = list.indexOf(value);
    var html = '<option value="">（未配置，识别时回退主模型）</option>';
    for (var i = 0; i < list.length; i++) {
      html += '<option value="' + esc(list[i]) + '">' + esc(list[i]) + '</option>';
    }
    html += '<option value="' + CUSTOM + '">' + CUSTOM + '</option>';
    selectEl.innerHTML = html;
    selectEl.value = idx >= 0 ? list[idx] : (value ? CUSTOM : '');
    inputEl.hidden = selectEl.value !== CUSTOM;
    if (selectEl.value === CUSTOM && value) inputEl.value = value;
  }

  /** 收集设置页当前填写的配置 */
  function collectSettings() {
    var patch = {
      mode: Store.getConfig().mode
    };
    if (patch.mode === 'selfkey') {
      var modelSel = $('settings-model');
      var visionSel = $('settings-vision');
      var active = null;
      var cells = doc.querySelectorAll('#settings-presets .preset-cell');
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].className.indexOf('active') >= 0) active = cells[i].getAttribute('data-preset');
      }
      var presetId = active || Store.getConfig().presetId || 'zhipu';
      var baseURL = String($('settings-baseurl').value || '').trim();
      if (!baseURL) {
        var preset = Api.getPreset(presetId);
        baseURL = preset ? preset.baseURL : '';
      }
      patch.presetId = presetId;
      patch.baseURL = baseURL;
      patch.apiKey = String($('settings-apikey').value || '').trim();
      patch.model = modelSel.value === '手输自定义'
        ? String($('settings-model-custom').value || '').trim()
        : modelSel.value;
      patch.visionModel = visionSel.value === '手输自定义'
        ? String($('settings-vision-custom').value || '').trim()
        : (visionSel.value === '（未配置，识别时回退主模型）' ? '' : visionSel.value);
    }
    return patch;
  }

  function saveSettings(quiet) {
    var cfg = Store.setConfig(collectSettings());
    if (!quiet) toast('已保存');
    refreshGradeTip();
    refreshChatTip();
    return cfg;
  }

  function onTestConnection() {
    var cfg = saveSettings(true);
    var btn = $('settings-test');
    var out = $('settings-test-result');
    btn.disabled = true;
    out.className = 'field-hint';
    out.textContent = '测试中…';
    Api.testConnection(cfg).then(function (res) {
      btn.disabled = false;
      out.className = res.ok ? 'field-hint gold' : 'field-hint danger';
      out.textContent = res.ok
        ? res.message + '（耗时 ' + res.latencyMs + ' 毫秒）'
        : res.message;
    }).catch(function (err) {
      btn.disabled = false;
      out.className = 'field-hint danger';
      out.textContent = '测试失败：' + ((err && err.message) || '未知错误');
    });
  }

  function onEnableOfficial() {
    var cfg = collectSettings();
    var out = $('settings-official-result');
    var btn = $('settings-official-enable');
    if (cfg.presetId !== 'zhipu' || !cfg.apiKey || cfg.baseURL.replace(/\/+$/, '') !== 'https://open.bigmodel.cn/api/paas/v4') {
      out.textContent = '请先选择智谱官方接口并填写 API Key。';
      return;
    }
    btn.disabled = true;
    out.textContent = '正在保存到本机服务端…';
    root.fetch('/api/admin/shared-model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: cfg.apiKey })
    }).then(function (res) { return res.json(); }).then(function (result) {
      if (!result.ok) throw new Error(result.error || '保存失败');
      Store.setConfig({ mode: 'server', apiKey: '', model: '', visionModel: '' });
      mountSettings();
      out.textContent = '已启用共享模型，登录账号后即可使用。注册邀请码已保留。';
      refreshGradeTip(); refreshChatTip();
      toast('已启用官方共享模型');
    }).catch(function (error) {
      out.textContent = error.message || '配置失败，请重试';
    }).then(function () { btn.disabled = false; });
  }

  // ================= 访问口令弹窗 =================

  function openCodeModal(hint) {
    if (root.Auth && !root.Auth.isOffline() && !root.Auth.isAuthenticated()) root.Auth.requireLogin(hint);
  }

  function closeCodeModal() {
    // Kept as a harmless compatibility hook for existing page callbacks.
  }

  /** 错误里带「口令」或 401 时，主动弹出口令框 */
  function maybePromptCode(message) {
    if (root.Auth && !root.Auth.isOffline() && !root.Auth.isAuthenticated()) root.Auth.requireLogin(message);
  }

  // ================= 事件绑定 =================

  function syncMobileKeyboard() {
    var viewport = root.visualViewport;
    if (!viewport) return;
    var offset = Math.max(0, root.innerHeight - viewport.height - viewport.offsetTop);
    var inChat = State.view === 'chat' && doc.activeElement === $('chat-input');
    doc.body.classList.toggle('keyboard-open', inChat && offset > 100);
    doc.documentElement.style.setProperty('--keyboard-offset', offset + 'px');
  }

  function bindEvents() {
    if (root.visualViewport) {
      root.visualViewport.addEventListener('resize', syncMobileKeyboard);
      root.visualViewport.addEventListener('scroll', syncMobileKeyboard);
      doc.addEventListener('focusin', syncMobileKeyboard);
      doc.addEventListener('focusout', function () { root.setTimeout(syncMobileKeyboard, 0); });
    }
    $('settings-official-enable').addEventListener('click', onEnableOfficial);
    root.addEventListener('hashchange', handleRoute);

    // ---- 批改 ----
    $('grade-question').addEventListener('input', updateLengthStandard);
    $('grade-answer').addEventListener('input', updateAnswerMeta);
    $('grade-submit').addEventListener('click', onGradeSubmit);
    $('grade-scan').addEventListener('click', function () {
      if (State.scanTask) {
        cancelScan(); // 识别中再点一次 = 取消
        return;
      }
      if (!Store.isConfigured()) {
        toast('还没有配置接入方式，请先到设置页设置');
        go('#/settings');
        return;
      }
      $('grade-file').click();
    });
    $('grade-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      onPickFile(f);
      e.target.value = '';
    });

    var typeSeg = $('grade-type-segmented');
    if (typeSeg) {
      typeSeg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.type-segment') : e.target;
        if (!btn || !btn.getAttribute) return;
        var t = btn.getAttribute('data-type');
        if (t) {
          syncTypeSegmented(t);
          var sel = $('grade-type');
          if (sel) {
            sel.value = t;
            var evt = doc.createEvent ? doc.createEvent('HTMLEvents') : null;
            if (evt) {
              evt.initEvent('change', true, true);
              sel.dispatchEvent(evt);
            }
          }
        }
      });
    }

    var matToggle = $('grade-material-toggle');
    var matWrap = $('grade-material-wrap');
    var matArrow = $('grade-material-arrow');
    if (matToggle && matWrap) {
      matToggle.addEventListener('click', function () {
        var isHidden = matWrap.classList.toggle('is-collapsed');
        if (matArrow) matArrow.textContent = isHidden ? '展开 ▾' : '收起 ▴';
      });
    }

    var refToggle = $('grade-reference-toggle');
    var refWrap = $('grade-reference-wrap');
    var refArrow = $('grade-reference-arrow');
    if (refToggle && refWrap) {
      refToggle.addEventListener('click', function () {
        var isHidden = refWrap.classList.toggle('is-collapsed');
        if (refArrow) refArrow.textContent = isHidden ? '展开 ▾' : '收起 ▴';
      });
    }

    var presetBox = $('grade-preset-chips');
    if (presetBox) {
      presetBox.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.preset-pill') : e.target;
        if (!btn || !btn.getAttribute) return;
        var p = btn.getAttribute('data-preset');
        if (p) loadPresetQuestion(p);
      });
    }

    var fillBtn = $('grade-fill-sample');
    if (fillBtn) fillBtn.addEventListener('click', fillSampleAnswer);

    var clearBtn = $('grade-clear-answer');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        var ans = $('grade-answer');
        if (ans) ans.value = '';
        updateAnswerMeta();
        toast('作答内容已清空');
      });
    }

    // ---- 结果 ----
    $('result-copy').addEventListener('click', onResultCopy);
    $('result-again').addEventListener('click', onResultAgain);
    $('result-retry').addEventListener('click', onResultRetry);

    // ---- 陪练 ----
    $('chat-chips').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var ask = t.getAttribute('data-ask');
      if (ask) sendChat(ask);
    });
    $('chat-new').addEventListener('click', newChat);
    $('chat-send').addEventListener('click', function () {
      sendChat($('chat-input').value);
    });
    $('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat($('chat-input').value);
      }
    });
    $('chat-input').addEventListener('input', function () {
      var ta = $('chat-input');
      ta.style.height = 'auto';
      ta.style.height = Math.min(120, Math.max(40, ta.scrollHeight)) + 'px';
    });

    // ---- 真题 ----
    $('papers-list').addEventListener('click', function (e) {
      // 套题头里包着两个 span，事件目标多半是 span 而不是带 data-paper 的容器，
      // 所以要沿父链往上找（与历史列表的处理一致）
      var t = e.target;
      while (t && t !== $('papers-list')) {
        if (t.getAttribute) {
          var paperId = t.getAttribute('data-paper');
          if (paperId) {
            State.openPapers[paperId] = !State.openPapers[paperId];
            mountPapers();
            return;
          }
          var qid = t.getAttribute('data-answer');
          if (qid) {
            prefillFromPapers(qid);
            return;
          }
        }
        t = t.parentNode;
      }
    });

    // ---- 备考 ----
    $('study-submit').addEventListener('click', onStudySubmit);
    $('study-copy').addEventListener('click', function () {
      var content = Store.getPlan().content || '';
      if (!content.trim()) {
        toast('还没有可复制的计划');
        return;
      }
      copyText(content);
    });
    $('study-reset').addEventListener('click', function () {
      var plan = Store.getPlan();
      var any = false;
      for (var k in plan.checkins) {
        if (Object.prototype.hasOwnProperty.call(plan.checkins, k) && plan.checkins[k]) {
          any = true;
          break;
        }
      }
      if (!any) {
        toast('还没有打卡记录');
        return;
      }
      if (!root.confirm('确定清空全部打卡记录吗？计划正文会保留。')) return;
      Store.setPlan({ checkins: {} });
      renderCheckins(Store.getPlan());
      toast('打卡已重置');
    });
    $('study-retry').addEventListener('click', onStudyRetry);
    $('study-goto-settings').addEventListener('click', function () {
      go('#/settings');
    });
    $('study-checkins').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var week = t.getAttribute('data-week');
      if (!week) return;
      var done = Store.toggleCheckin(week);
      renderCheckins(Store.getPlan());
      toast(done ? '第' + week + '周已打卡' : '已取消第' + week + '周打卡');
    });

    // ---- 历史 ----
    $('history-tabs').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var f = t.getAttribute('data-filter');
      if (!f) return;
      State.historyFilter = f;
      var chips = doc.querySelectorAll('#history-tabs .chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].className = chips[i].getAttribute('data-filter') === f ? 'chip chip-active' : 'chip';
      }
      mountHistory();
    });
    $('history-list').addEventListener('click', function (e) {
      // 删除按钮优先：它也泡在 data-history 的祖先里，不拦住会误跳详情
      var t = e.target;
      while (t && t !== $('history-list')) {
        if (t.getAttribute) {
          var delId = t.getAttribute('data-del');
          if (delId) {
            var delItem = Store.getHistoryById(delId);
            var delTitle = (delItem && delItem.title) || '这条记录';
            if (!root.confirm('确定删除「' + delTitle + '」吗？删除后不可恢复。')) return;
            Store.removeHistory(delId);
            mountHistory();
            toast('已删除');
            return;
          }
          if (t.getAttribute('data-history')) {
            openHistoryItem(t.getAttribute('data-history'));
            return;
          }
        }
        t = t.parentNode;
      }
    });
    $('history-clear').addEventListener('click', function () {
      if (!Store.getHistory().length) {
        toast('历史本来就是空的');
        return;
      }
      if (!root.confirm('确定清空全部批改与对话记录吗？此操作不可撤销。')) return;
      Store.clearHistory();
      mountHistory();
      toast('已清空');
    });

    // ---- 设置 ----
    $('settings-mode').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var mode = t.getAttribute('data-mode');
      if (!mode) return;
      Store.setConfig({ mode: mode });
      mountSettings();
    });
    $('settings-presets').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var id = t.getAttribute('data-preset');
      if (!id) return;
      var preset = Api.getPreset(id);
      Store.setConfig({ presetId: id, baseURL: preset ? preset.baseURL : '' });
      mountSettings();
    });
    // 下拉只负责「切换候选项 / 显隐手输框」：候选列表由预设决定，改选项时不能
    // 用空值重建，否则会把刚选中的模型冲成「手输自定义」。
    $('settings-model').addEventListener('change', function () {
      var input = $('settings-model-custom');
      if (input) input.hidden = $('settings-model').value !== '手输自定义';
    });
    $('settings-vision').addEventListener('change', function () {
      var input = $('settings-vision-custom');
      if (input) input.hidden = $('settings-vision').value !== '手输自定义';
    });
    $('settings-save').addEventListener('click', function () {
      saveSettings(false);
    });
    $('settings-test').addEventListener('click', onTestConnection);

    // ---- 推荐模型方案：一键配置 ----
    var guideBox = $('settings-guide');
    if (guideBox) {
      guideBox.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.getAttribute) return;
        var id = t.getAttribute('data-guide');
        if (!id) return;
        var preset = Api.getPreset(id);
        if (!preset) return;
        var model = (preset.models && preset.models[0]) || '';
        Store.setConfig({
          mode: 'selfkey',
          presetId: id,
          baseURL: preset.baseURL,
          model: model
        });
        mountSettings();
        var keyEl = $('settings-apikey');
        if (keyEl) {
          try { keyEl.focus(); } catch (err) { /* 忽略 */ }
        }
        toast('已切到「' + preset.name + '」，把 API Key 粘进来即可使用');
      });
    }

  }

  // ================= 启动 =================

  function boot() {
    fillSelect($('grade-type'), TYPE_OPTIONS, TYPE_OPTIONS[0]);
    bindEvents();
    updateAnswerMeta();

    if (!root.location.hash) go('#/grade');
    else handleRoute();

    // 本地文件打开（把「申论朱批.html」发给朋友、手机/电脑本地双击）：
    // 没有服务器可转发，适配为「自带 Key 模式」并给出引导，而不是弹访问口令。
    var cfg = Store.getConfig();
    if (root.location.protocol === 'file:') {
      if (!Store.hasStoredConfig()) {
        cfg = Store.setConfig({ mode: 'selfkey' });
      }
      if (cfg.mode === 'selfkey' && !cfg.apiKey) {
        setTimeout(function () {
          toast('本地离线使用：请到「设置」选一个模型（推荐 DeepSeek / 智谱），填上你自己的 API Key 即可批改', 5000);
        }, 600);
      }
      return;
    }

  }

  // Runs synchronously before account transitions or a privacy curtain.
  root.resetAccountActivity = function () {
    abortGradeStream(); stopResultPolling(); abortChat(); abortScan();
    if (State.study.task && typeof State.study.task.abort === 'function') State.study.task.abort();
    State.study.task = null;
    $('chat-bar').hidden = true;
  };

  function startWithSession() {
    if (root.AuthUI) root.AuthUI.start(boot);
    else if (root.location.protocol === 'file:') {
      doc.body.classList.remove('auth-locked');
      boot();
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', startWithSession);
  } else {
    startWithSession();
  }
})(typeof window !== 'undefined' ? window : this, document);
