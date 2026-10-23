/**
 * pages/chat/chat.js —— 解题陪练聊天页（方案 §4「解题」行）
 *
 * 职责：
 *   1. 聊天气泡：用户右侧朱红浅底、AI 左侧纸白卡片，AI 内容用 utils/md.js 块渲染；
 *   2. 流式打字效果：onDelta 累积文本，每 300ms 节流重渲染最后一条 AI 消息，滚动到底；
 *   3. 顶部五个快捷指令 chips，点击即作为用户消息发送；
 *   4. system 取 skill/prompts.js 的 COACH_PROMPT（自定义 Skill 开启时覆盖），
 *      多轮对话只带最近 20 条；
 *   5. 输入区固定底部、发送中禁用；长按消息复制；「新对话」把当前会话写入历史（type:chat）后清空；
 *      带 options.id 进入时载入该历史会话，只读浏览；
 *   6. onUnload 中止请求；错误按 utils/api.js 的约定展示错误卡并支持重试。
 *
 * 依赖的公共层签名（均已核对源码）：
 *   api.chatStream(cfg, messages, {onDelta,onDone,onError}) → RequestTask
 *   md.parseBlocks(text) → [{type,text,segments:[{text,bold}]}]
 *   store.getConfig() / getSkillCustom() / getHistoryById(id) / addHistory(item) / updateHistory(id, patch)
 *   prompts.COACH_PROMPT（字符串）
 */

var api = require('../../utils/api.js');
var md = require('../../utils/md.js');
var store = require('../../utils/storage.js');
var prompts = require('../../skill/prompts.js');
var refs = require('../../skill/references.js');
var format = require('../../utils/format.js');
var privacy = require('../../utils/privacy.js');
var aigc = require('../../utils/aigc.js');

// 顶部快捷指令（方案 §4 指定的五个，顺序与文案照抄）
var QUICK_ASKS = [
  '这道申论题怎么做',
  '归纳概括怎么找点',
  '申论大作文怎么写',
  '帮我做一套申论真题',
  '备考规划'
];

// 名师专题参考路由表（skill/references.js）：按用户最新消息命中正则，
// 依序收集对应专题，最多注入 3 篇、总量封顶，避免 system 过长。
// 顺序即优先级：名师点名 > 具体题型 > 泛化问法。
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

var REF_MAX_CHARS = 26000;

/**
 * 按用户最新消息挑选要注入的名师专题参考全文
 * @param {string} text 用户最新一条消息
 * @returns {string[]} 命中的参考文本数组（可能为空）
 */
function pickReferences(text) {
  var picked = [];
  var pickedKeys = [];
  var total = 0;
  if (!text) return picked;
  for (var i = 0; i < REF_ROUTES.length && picked.length < 3; i++) {
    var route = REF_ROUTES[i];
    if (!route.re.test(text)) continue;
    for (var j = 0; j < route.keys.length && picked.length < 3; j++) {
      var key = route.keys[j];
      if (pickedKeys.indexOf(key) !== -1) continue;
      var content = refs.REF && refs.REF[key];
      if (typeof content !== 'string' || !content) continue;
      if (total + content.length > REF_MAX_CHARS) continue;
      pickedKeys.push(key);
      picked.push('—— 专题：' + key + ' ——\n' + content);
      total += content.length;
    }
  }
  return picked;
}

// 多轮对话保留最近多少条（不含 system）
var HISTORY_TAIL = 20;
// 流式渲染节流间隔（毫秒）
var RENDER_THROTTLE = 300;

/** 解析 markdown 并补上 wx:key 用的稳定键（md.js 不带键，这里补 index 派生键） */
function renderBlocks(text) {
  var blocks = md.parseBlocks(text);
  for (var i = 0; i < blocks.length; i++) {
    blocks[i].key = 'b' + i;
    var segs = blocks[i].segments || [];
    for (var j = 0; j < segs.length; j++) {
      segs[j].key = 's' + i + '_' + j;
    }
  }
  return blocks;
}

/** 复制消息对象并合并局部字段 */
function cloneMsg(m, patch) {
  var out = {
    id: m.id,
    role: m.role,
    text: m.text,
    time: m.time,
    timeStr: m.timeStr,
    streaming: !!m.streaming,
    blocks: m.blocks || []
  };
  if (patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
    }
  }
  return out;
}

Page({
  data: {
    messages: [],        // [{id, role:'user'|'ai', text, time, streaming, blocks}]
    quickAsks: QUICK_ASKS,
    inputText: '',
    sending: false,      // 请求进行中：禁用输入与发送
    errorText: '',       // 错误卡文案，空串表示无错误
    readonly: false,     // 历史回看模式（只读）
    viewRecordId: '',    // 正在回看的历史记录 id
    scrollIntoView: ''   // scroll-view 滚底锚点
  },

  onLoad: function (options) {
    // 非 data 的运行时状态
    this._task = null;        // 当前 RequestTask，onUnload 时 abort
    this._buf = '';           // 流式累积文本（不进 setData，避免逐字符刷新）
    this._lastRender = 0;     // 上次节流渲染的时间戳
    this._recordId = '';      // 本次会话对应的历史记录 id
    this._aiMsgId = '';       // 正在流式生成的那条 AI 消息 id
    this._seq = 0;            // 消息 id 自增序号

    var id = options && options.id ? String(options.id) : '';
    if (id) this.loadFromHistory(id);
  },

  /**
   * 解题页是 tabBar 页，switchTab 不能带 query；首页/历史页回看某段对话时
   * 把记录 id 放在 app.globalData.chatViewId，这里取用并进入只读回看模式。
   */
  onShow: function () {
    var app = getApp();
    var g = app && app.globalData;
    if (!g || !g.chatViewId) return;
    var id = g.chatViewId;
    g.chatViewId = '';
    if (this.data.sending) this.abortRequest();
    this._recordId = '';
    this.setData({
      messages: [],
      inputText: '',
      sending: false,
      errorText: '',
      readonly: false,
      viewRecordId: ''
    });
    this.loadFromHistory(id);
  },

  // ---------------- 历史回看（只读） ----------------

  /**
   * 从历史载入一个对话会话，进入只读浏览模式
   * @param {string} id 历史记录 id（历史/首页回看时经 globalData.chatViewId 传入，
   *                   非 tabBar 入口时也可由 options.id 传入）
   */
  loadFromHistory: function (id) {
    var record = store.getHistoryById(id);
    if (!record || record.type !== 'chat') {
      wx.showToast({ title: '找不到这段对话记录', icon: 'none' });
      return;
    }
    var raw = (record.payload && record.payload.messages) || [];
    var self = this;
    var messages = [];
    raw.forEach(function (m) {
      if (!m || !m.content) return;
      var role = m.role === 'user' ? 'user' : 'ai';
      var time = m.time || record.time || Date.now();
      messages.push({
        id: self.nextId(),
        role: role,
        text: String(m.content),
        time: time,
        timeStr: format.formatTime(time),
        streaming: false,
        blocks: role === 'ai' ? renderBlocks(String(m.content)) : []
      });
    });
    this.setData({
      messages: messages,
      readonly: true,
      viewRecordId: id
    });
    this.scrollToBottom();
  },

  /** 退出只读，继续在这段对话上聊（仍写回同一条历史记录） */
  onContinueChat: function () {
    var id = this.data.viewRecordId;
    this._recordId = id;
    this.setData({ readonly: false, viewRecordId: '' });
  },

  // ---------------- 消息组装 ----------------

  nextId: function () {
    this._seq += 1;
    return 'm' + Date.now().toString(36) + this._seq;
  },

  makeMsg: function (role, text) {
    var time = Date.now();
    return {
      id: this.nextId(),
      role: role,
      text: text,
      time: time,
      timeStr: format.formatTime(time),
      streaming: false,
      blocks: role === 'ai' ? renderBlocks(text) : []
    };
  },

  /**
   * 组装 system：自定义 Skill 开启且有内容时覆盖内置提示词；
   * 否则用 COACH_PROMPT + 名师路由附录，并按用户最新消息注入专题参考
   * @param {string} latestText 用户最新一条消息（用于专题路由）
   * @returns {string}
   */
  buildSystemPrompt: function (latestText) {
    var custom = store.getSkillCustom();
    if (custom && custom.enabled && custom.text && String(custom.text).trim()) {
      return custom.text;
    }
    var base = prompts.COACH_PROMPT + '\n\n' + prompts.SKILL_ROUTER;
    var injected = pickReferences(String(latestText || ''));
    if (injected.length) {
      base += '\n\n【专题参考】以下内容仅供教学参考，题干材料和证据规则优先：\n\n'
        + injected.join('\n\n');
    }
    return base + '\n\n' + prompts.QUALITY_RULES;
  },

  /**
   * 取当前对话（不含 system），并按最近 20 条截断
   * @returns {Array<{role:string, content:string}>}
   */
  buildConversation: function () {
    var conv = [];
    this.data.messages.forEach(function (m) {
      if (!m.text) return;
      conv.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text
      });
    });
    if (conv.length > HISTORY_TAIL) conv = conv.slice(conv.length - HISTORY_TAIL);
    return conv;
  },

  // ---------------- 发送与流式 ----------------

  /**
   * 发送一条用户消息（输入框、快捷指令 chip 共用）
   * @param {string} rawText 用户输入
   */
  send: function (rawText) {
    var text = String(rawText == null ? '' : rawText).trim();
    if (!text || this.data.sending || this.data.readonly) return;
    var userMsg = this.makeMsg('user', text);
    this.setData({
      messages: this.data.messages.concat([userMsg]),
      inputText: '',
      errorText: ''
    });
    this.ensureRecord(text);
    this.scrollToBottom();
    this.requestAnswer();
  },

  /** 首次发消息时建一条历史记录，之后一直复用同一 id 更新 */
  ensureRecord: function (firstText) {
    if (this._recordId) return;
    var record = store.addHistory({
      type: 'chat',
      title: format.brief(firstText, 18) || '解题对话',
      payload: { messages: [] }
    });
    if (record && record.id) this._recordId = record.id;
  },

  /** 把当前会话写入/更新历史（type:chat） */
  saveHistory: function () {
    if (this.data.readonly) return;
    var msgs = this.data.messages.filter(function (m) {
      return !!m.text;
    });
    if (!msgs.length) return;
    var payloadMessages = msgs.map(function (m) {
      return {
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text,
        time: m.time
      };
    });
    var firstUser = '';
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user') {
        firstUser = msgs[i].text;
        break;
      }
    }
    var title = format.brief(firstUser, 18) || '解题对话';
    if (this._recordId) {
      store.updateHistory(this._recordId, {
        title: title,
        time: Date.now(),
        payload: { messages: payloadMessages }
      });
    } else {
      var record = store.addHistory({
        type: 'chat',
        title: title,
        payload: { messages: payloadMessages }
      });
      if (record && record.id) this._recordId = record.id;
    }
  },

  /** 发起一次流式问答 */
  requestAnswer: function () {
    var self = this;
    var conversation = this.buildConversation();
    var latest = conversation.length ? conversation[conversation.length - 1].content : '';
    var messages = [{ role: 'system', content: this.buildSystemPrompt(latest) }].concat(conversation);

    var aiMsg = this.makeMsg('ai', '');
    aiMsg.streaming = true;
    this._aiMsgId = aiMsg.id;
    this._buf = '';
    this._lastRender = 0;
    this._task = null; // 先置空：若 chatStream 因配置不全直接报错返回 null，可据此判定没有降级机会

    this.setData({
      messages: this.data.messages.concat([aiMsg]),
      sending: true,
      errorText: ''
    });
    this.scrollToBottom();

    this._task = api.chatStream(store.getConfig(), messages, {
      onDelta: function (delta) {
        self.handleDelta(delta);
      },
      onDone: function (fullText) {
        self.handleDone(fullText);
      },
      onError: function (message) {
        self.handleError(message);
      }
    });
  },

  /**
   * 追加增量文本；每 RENDER_THROTTLE 毫秒才真正重渲染一次最后一条 AI 消息
   * @param {string} delta 本次增量
   */
  handleDelta: function (delta) {
    if (!delta) return;
    this._buf += delta;
    var now = Date.now();
    if (now - this._lastRender < RENDER_THROTTLE) return;
    this._lastRender = now;
    this.paintStreaming();
  },

  /** 把累积文本刷进最后一条 AI 消息的块结构 */
  paintStreaming: function () {
    var list = this.data.messages.slice();
    var last = list[list.length - 1];
    if (!last || last.id !== this._aiMsgId) return;
    list[list.length - 1] = cloneMsg(last, {
      text: this._buf,
      blocks: renderBlocks(this._buf)
    });
    this.setData({ messages: list });
    this.scrollToBottom();
  },

  /**
   * 流式正常结束
   * @param {string} fullText 全文
   */
  handleDone: function (fullText) {
    var text = (typeof fullText === 'string' && fullText) ? fullText : this._buf;
    var list = this.data.messages.slice();
    var last = list[list.length - 1];
    if (last && last.id === this._aiMsgId) {
      list[list.length - 1] = cloneMsg(last, {
        text: text,
        streaming: false,
        blocks: renderBlocks(text)
      });
    }
    this._task = null;
    this._buf = text;
    this.setData({
      messages: list,
      sending: false,
      // 已经拿到内容就把可能残留的错误卡撤下（api.js 降级成功时会先 onError 再 onDelta/onDone）
      errorText: text ? '' : this.data.errorText
    });
    this.scrollToBottom();
    this.saveHistory();
  },

  /**
   * 流式出错：按 api.js 约定，仍可能自动降级一次非流式请求，
   * 因此只有拿不到 RequestTask（配置不全等）时才立刻结束发送态。
   * @param {string} message 中文错误文案
   */
  handleError: function (message) {
    var text = message || '请求失败，请稍后重试。';
    var list = this.data.messages.slice();
    var last = list[list.length - 1];
    if (last && last.id === this._aiMsgId && !last.text) {
      list.pop(); // 空气泡撤掉
    } else if (last && last.id === this._aiMsgId) {
      list[list.length - 1] = cloneMsg(last, { streaming: false });
    }
    this._task = null;
    this.setData({
      messages: list,
      sending: false,
      errorText: text
    });
    this.scrollToBottom();
    this.saveHistory();
  },

  /** 错误卡上的重试：撤掉上一轮 AI 回复，用同一批上下文再问一次 */
  onRetry: function () {
    if (this.data.sending || this.data.readonly) return;
    var list = this.data.messages.slice();
    while (list.length && list[list.length - 1].role === 'ai') list.pop();
    this.setData({ messages: list, errorText: '' });
    this.requestAnswer();
  },

  /** 中止进行中的请求（同样用于 onUnload） */
  abortRequest: function () {
    if (this._task && typeof this._task.abort === 'function') {
      try {
        this._task.abort();
      } catch (e) {
        console.error('[chat] 中止请求失败：', e);
      }
    }
    this._task = null;
  },

  // ---------------- 交互事件 ----------------

  onInput: function (e) {
    this.setData({ inputText: e.detail.value });
  },

  onSendTap: function () {
    this.send(this.data.inputText);
  },

  onChipTap: function (e) {
    var text = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.text) || '';
    this.send(text);
  },

  /** 长按消息气泡复制原文 */
  onLongPressMsg: function (e) {
    var self = this;
    // 剪贴板属隐私接口：先过隐私授权
    privacy.ensurePrivacy(function () {
      self.doCopyMsg(e);
    }, '需要同意《用户隐私保护指引》后才能复制');
  },

  doCopyMsg: function (e) {
    var index = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : -1;
    var msg = this.data.messages[Number(index)];
    if (!msg || !msg.text) return;
    wx.setClipboardData({
      data: msg.role === 'ai' ? aigc.forClipboard(msg.text) : msg.text,
      fail: function () {
        wx.showToast({ title: '复制失败，请长按选中文字', icon: 'none' });
      }
    });
  },

  /** 新对话：当前会话写入历史（type:chat）后清空 */
  onNewChat: function () {
    if (this.data.sending) this.abortRequest();
    this.saveHistory();
    this._buf = '';
    this._aiMsgId = '';
    this._recordId = '';
    this._lastRender = 0;
    this.setData({
      messages: [],
      inputText: '',
      sending: false,
      errorText: '',
      readonly: false,
      viewRecordId: '',
      scrollIntoView: ''
    });
    wx.showToast({ title: '已开始新的对话', icon: 'none' });
  },

  /** 错误卡上的「去设置」 */
  onGoSettings: function () {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  /** 滚到底：先把锚点清空再赋值，保证 scroll-into-view 每次都能触发 */
  scrollToBottom: function () {
    var self = this;
    this.setData({ scrollIntoView: '' });
    setTimeout(function () {
      self.setData({ scrollIntoView: 'msg-bottom' });
    }, 30);
  },

  // ---------------- 生命周期 ----------------

  onHide: function () {
    // 切到别的 tab 时把进度落盘，避免这段对话白聊
    this.saveHistory();
  },

  onUnload: function () {
    this.saveHistory();
    this.abortRequest();
  }
});
