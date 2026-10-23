'use strict';
// Record per-paper answer accessibility. Answer/explain pages on gkzhenti.cn are behind a
// math-image captcha (deliberate access control) — recorded as captcha-gated, not bypassed.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/paper-catalog.json'), 'utf8'));
  const auditPath = path.join(ROOT, 'data/answer-audit.json');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const byId = new Map(audit.papers.map(p => [p.paperId, p]));

  for (const p of catalog.papers) {
    const entry = byId.get(p.id);
    if (!entry) continue;
    if (p.sourceUrl && p.sourceUrl.startsWith('https://gwy.gkzhenti.cn')) {
      const id = p.id.replace('source_', '');
      entry.answerAccessibility = {
        officialPage: { answer: `https://gwy.gkzhenti.cn/answer/${id}`, explain: `https://gwy.gkzhenti.cn/explain/${id}` },
        status: 'captcha-gated',
        note: '站点对答案/解析页设置图片算术验证码，属站方访问控制，未程序化绕过；可人工浏览器访问后录入。'
      };
    } else {
      entry.answerAccessibility = {
        officialPage: null,
        status: 'external-source',
        note: '来源为第三方页面（' + p.sourceUrl + '），未发现正文答案。'
      };
    }
    for (const s of (p.answerSources || [])) {
      s.accessibility = s.accessibility || 'download-or-login-gated（2026-10-11 复核：页面含题干，答案需下载/登录）';
    }
  }

  audit.accessibilityCheckedAt = new Date().toISOString();
  const byStatus = {};
  for (const p of audit.papers) {
    const st = p.answerAccessibility ? p.answerAccessibility.status : 'unknown';
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  audit.accessibilitySummary = byStatus;
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');

  fs.writeFileSync(
    path.join(ROOT, 'docs/全部试卷答案核验进度.md'),
    `# 全部试卷答案核验进度

共 ${audit.total} 份试卷；找到入口不等于取得答案。已核验并用于校准的历年试卷：0。

## 匹配状态

${Object.entries(audit.summary).map(([k, v]) => '- ' + k + '：' + v).join('\n')}

## 答案正文可达性（${audit.accessibilityCheckedAt.slice(0, 10)} 复核）

${Object.entries(byStatus).map(([k, v]) => '- ' + k + '：' + v).join('\n')}

结论：截至本次复核，没有可批量程序化获取的答案正文来源——

- gkzhenti.cn 答案/解析页统一设置图片算术验证码（站方访问控制，未绕过）；
- aipta.com 等第三方页仅含题干，答案需下载或登录；
- 百度文库类需登录付费；知乎/机构站有反爬或拒绝访问。

逐卷清单及各卷答案入口见 data/answer-audit.json。答案正文导入需人工浏览器访问逐卷录入，或采用明确标注的 AI 生成要点（不得当作官方答案）。
`)
    ;
  console.log(JSON.stringify({ total: audit.total, accessibility: byStatus }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
