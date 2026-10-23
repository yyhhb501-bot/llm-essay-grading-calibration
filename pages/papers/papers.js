'use strict';
var library = require('../../utils/paper-library.js');
var examples = require('../../data/papers.js').PAPERS;
var auth = require('../../utils/auth.js');
var privacy = require('../../utils/privacy.js');
var PAGE_SIZE = 20;

Page({
  data: {
    mode: 'full', keyword: '', years: ['全部年份'], regions: ['全部地区'], yearIndex: 0, regionIndex: 0,
    papers: [], filteredCount: 0, hasMore: false, expandedId: '', activePaper: null,
    loading: false, errorMsg: '', authenticated: false,
    totalPapers: library.index.totals.papers, totalQuestions: library.index.totals.questions
  },
  onLoad: function () { this._alive = true; this._seq = 0; this._owner = auth.version(); this.buildFilters(); this.filterList(); },
  onShow: function () {
    this.setData({ authenticated: !!auth.getSession() });
    if (this._owner !== auth.version()) { this._owner = auth.version(); this.closeDetails(); }
  },
  onUnload: function () { this._alive = false; this._seq++; this._paper = null; },
  buildFilters: function () {
    var list = this.getAll(), years = [], regions = [];
    list.forEach(function (p) {
      if (years.indexOf(String(p.year)) === -1) years.push(String(p.year));
      if (p.region && regions.indexOf(p.region) === -1) regions.push(p.region);
    });
    years.sort(function (a, b) { return Number(b) - Number(a); }); regions.sort();
    this.setData({ years: ['全部年份'].concat(years), regions: ['全部地区'].concat(regions), yearIndex: 0, regionIndex: 0 });
  },
  getAll: function () {
    if (this.data.mode === 'full') return library.index.papers;
    return examples.map(function (p) { return { id: p.id, title: p.title, year: p.year, region: '', materials: 0, questions: p.questions.length, recalled: false }; });
  },
  filterList: function () {
    var d = this.data, query = String(d.keyword || '').trim().toLowerCase();
    this._filtered = this.getAll().filter(function (p) {
      return (!d.yearIndex || String(p.year) === d.years[d.yearIndex]) &&
        (!d.regionIndex || p.region === d.regions[d.regionIndex]) &&
        (!query || (p.title + ' ' + p.region).toLowerCase().indexOf(query) !== -1);
    });
    this.closeDetails();
    this._limit = PAGE_SIZE; this.renderList();
  },
  renderList: function () {
    this.setData({ papers: this._filtered.slice(0, this._limit), filteredCount: this._filtered.length, hasMore: this._filtered.length > this._limit });
  },
  onLoadMore: function () { this._limit += PAGE_SIZE; this.renderList(); },
  onKeywordInput: function (e) { this.setData({ keyword: e.detail.value }); this.filterList(); },
  onYearChange: function (e) { this.setData({ yearIndex: Number(e.detail.value) }); this.filterList(); },
  onRegionChange: function (e) { this.setData({ regionIndex: Number(e.detail.value) }); this.filterList(); },
  onModeTap: function (e) {
    var mode = e.currentTarget.dataset.mode;
    if (mode !== 'full' && mode !== 'example') return;
    this.setData({ mode: mode, keyword: '' }); this.buildFilters(); this.filterList();
  },
  closeDetails: function () {
    this._seq++; this._paper = null;
    this.setData({ expandedId: '', activePaper: null, loading: false, errorMsg: '' });
  },
  togglePaper: function (e) {
    var id = e.currentTarget.dataset.id;
    if (id === this.data.expandedId) { this.closeDetails(); return; }
    this.openPaper(id);
  },
  onRetry: function () { this.openPaper(this.data.expandedId); },
  openPaper: function (id) {
    var self = this, seq = ++this._seq;
    this._paper = null;
    this.setData({ expandedId: id, activePaper: null, loading: true, errorMsg: '' });
    if (this.data.mode === 'example') {
      var p = examples.filter(function (paper) { return paper.id === id; })[0];
      if (!p) { this.closeDetails(); return; }
      this._paper = p;
      this.setData({ loading: false, activePaper: { title: p.title, sourceNote: p.note, sourceUrl: '', materials: [],
        questions: p.questions.map(function (q, i) { return { index: i, no: i + 1, stem: q.question, requirements: [], scoreText: '', exampleMaterial: q.material, keypoints: q.keypoints || [] }; })
      } });
      return;
    }
    var owner = auth.version();
    library.loadPaper(id).then(function (paper) {
      if (!self._alive || seq !== self._seq || owner !== auth.version()) return;
      self._paper = paper;
      self.setData({ loading: false, activePaper: {
        title: paper.title, sourceNote: paper.copyrightNote || '第三方收录内容，非官方发布版本，请核对来源。', sourceUrl: paper.sourceUrl || '',
        materials: paper.materials.map(function (m, i) { return { index: i, no: m.no || i + 1, text: m.text, preview: m.text.slice(0, 320), length: m.text.length, expanded: false }; }),
        questions: paper.questions.map(function (q, i) { return { index: i, no: q.no || i + 1, stem: q.stem, requirements: q.requirements || [],
          scoreText: typeof q.score === 'number' && q.score > 0 ? q.score + ' 分' : '分值未识别', keypoints: [] }; })
      } });
    }).catch(function (error) {
      if (self._alive && seq === self._seq && owner === auth.version()) self.setData({ loading: false, errorMsg: error.message });
    });
  },
  onToggleMaterial: function (e) {
    var i = Number(e.currentTarget.dataset.index), paper = this.data.activePaper;
    if (!paper || !paper.materials[i]) return;
    var key = 'activePaper.materials[' + i + '].expanded', patch = {};
    patch[key] = !paper.materials[i].expanded; this.setData(patch);
  },
  onGoAccount: function () { wx.navigateTo({ url: '/pages/account/account' }); },
  onCopySource: function () {
    var source = this.data.activePaper && this.data.activePaper.sourceUrl;
    if (source) privacy.ensurePrivacy(function () { wx.setClipboardData({ data: source }); });
  },
  onAnswer: function (e) {
    if (!this._paper || this.data.loading || auth.isSwitching()) return;
    var i = Number(e.currentTarget.dataset.index), payload;
    if (!isFinite(i) || i < 0 || i % 1 || !this._paper.questions[i]) return;
    if (this.data.mode === 'full') {
      if (!auth.getSession() || this._owner !== auth.version()) { wx.showToast({ title: '请重新登录后载入试卷', icon: 'none' }); return; }
      payload = library.prepareQuestion(this._paper, i);
    } else {
      var q = this._paper.questions[i];
      payload = { id: q.id, paperTitle: this._paper.title, question: q.question, material: q.material, type: q.type,
        sourceLabel: '内置改编练习 · 非原卷', sourceNote: this._paper.note, sourceUrl: '', referenceAnswer: '' };
    }
    payload.owner = auth.version();
    var app = getApp();
    app.globalData.gradePrefillPayload = payload; app.globalData.gradePrefillId = '';
    wx.switchTab({ url: '/pages/grade/grade', fail: function () {
      if (app.globalData.gradePrefillPayload === payload) app.globalData.gradePrefillPayload = null;
      wx.showToast({ title: '打开作答页失败，请重试', icon: 'none' });
    } });
  }
});
