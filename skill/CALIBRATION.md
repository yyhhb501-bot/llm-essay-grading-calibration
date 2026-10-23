# 批改 Skill 校准记录

## 1.3.2 第一轮

范围：376 份来源目录，逐卷进度见 `data/answer-audit.json`。第一轮匹配 212 份来源入口、79 份卷别待核对、85 份暂未匹配。所有原卷的材料、答案正文及用于校准状态仍为未完成，不把来源匹配当作答案核验。

本轮规则改动依据：1.3.1 自拟样例实测报告把“督查”相对于“检查”提示为用词略重。此种意见可作风格建议，但应先证明语义、职责或范围实质改变才作为失分依据。新规则认可语境等价动作，并使独立信息覆盖评价不依赖参考答案拆成几条。

评测使用原创社区服务材料及自拟答案，不是未经核验的历年官方样本。新增 `reference-equivalent-grouping`：同一内容参考拆成六条、考生合成三类，保持动作、对象、条件和结果相同，检查评分与批注是否认可。测试命令：`node tools/evaluate-skill.js reference-equivalent-grouping`。

后续每卷须先核对题干、材料编号和版本，再核验参考的证据单元；机构之间分歧回到材料判断。原卷未取得、版本错配、只有目录或下载标题时不得进入有效样例集。评分公式只能使用有出处且适用于本题的说明，不采纳作者自拟公式为官方标准。

来源发现索引：[省考答案目录](https://m.aipta.com/zt/sk/)、[国考答案目录](https://m.aipta.com/zt/gk/)。标题元数据用于寻找入口，答案原文未批量转载或注入提示词。
`n实测结果：GLM-5.3-Flash 对 reference-equivalent-grouping 返回训练指数98，行为与输出契约断言通过，耗时196619毫秒。仅一条原创案例，不代表376份原卷均已校准或官方评分准确率。

## 1.3.2 第二轮：真实答案数据管线开工（2026-10-11）

数据侧突破：知乎公开解析 152 篇（约58万字）已抓取并按卷匹配（90/380 套，data/answers-crawled/ 与 paper-catalog.answerSources）；2020—2026 国考三卷别全覆盖。原卷正文爬取进行中（gkzhenti 65秒/卷，凌晨窗口，data/papers-full/）。

- P0-1 采分点锚点库：tools/extract-answer-points.js 把答案文章抽成题目级结构（题干/分值/题型/各机构要点/评分标准），data/answer-points/。先跑国考。
- P0-2 自动注入：tools/sync-site-papers.js 同步到 site/js/vendor/；真题目录「选题作答→预填到批改」自动带材料与非官方参考答案（app.js prefillFromPaperQuestion，同题多记录按题干相似度选优）。
- 待办（P1）：多机构同题答案做共识对齐→「共识点/可争议点」，把"要点完整度"从印象分改造成可复算的加权覆盖率；用真实题建 30–50 条 evaluate-skill 行为回归用例（同义改写≥抄字面、漏共识点降档、参考漏写材料支持不冤枉）。
- 边界不变：锚点叫训练锚点不叫官方采分表；机构答案分歧回材料裁决；第三方答案全部标注非官方。

## 1.3.3 第三轮：闭环可复算覆盖率接入网站（2026-10-16）

把「要点完整度」从模型印象分改造成程序可复算的共识加权覆盖率（对应第二轮 P1 的前半）：

- 算法：tools/coverage-score.js 为唯一口径源（单源权重 0.4；共识 1.0 起每多一家 +0.25、上限 2.0；命中完整/部分/偏差/未写 = 1/0.5/0.2/0；要点分 = 题型满分 × 覆盖率；估算卷面分必须标注非官方）。tools/build-site.js 打包为浏览器全局 window.CoverageScore（site/js/vendor/coverage.js），网站与工具同源复用。
- 流程：真题预填（该题有共识数据）→ 两阶段批改。Stage A 用 skill/prompts.js 的 ANCHOR_MATCH_PROMPT（与 tools/match-student-points.js 同一份）逐组判定命中；程序核算覆盖率与要点分；Stage B 在主批改提示词注入【共识锚点程序核算】块，GRADE_PROMPT 强制直接采用核算分值、逐组解释命中。个人自拟题、无共识数据、Stage A 失败或返回非 JSON 一律静默回退单阶段，不向用户报错。
- 转发层：site-server.js 与 worker/worker.js 改为原样透传客户端显式 temperature/thinking/max_tokens（EdgeOne functions/api/chat.js 原本已支持），窄任务可拿低温、关思考的确定性输出；未显式传时维持原有默认。
- 自测：新增 tools/test-coverage.js（算法契约）、tools/test-anchor-flow.js（两阶段成功/回退/迟到作废/依赖缺失）；tools/test-site-api.js 补 chatOnce 断言；tools/test-site.js 补覆盖率模块静态检查与转发透传断言；tools/validate.js 修复 export async function 的 ESM 识别误判。
- 数据现状：91 份 answer-points、6 份 consensus-points（site vendor 4 份），22 套卷可对齐（node tools/build-consensus-points.js --list）。
- 边界：覆盖率核算只在有共识对齐的真题上生效；锚点是训练口径，不是官方采分表。小程序端暂未接入（其运行环境无共识数据文件）。
- 实机验收（2026-10-16）：`node tools/test-anchor-closure.js`（默认 2021 苏A 第三题，11 组共识、材料齐全）走完整链路——Stage A 逐组判定 26.6s → 程序核算覆盖率 86.4%、要点完整度 34.5/40 → Stage B 报告 189.7s、scores 直接采用 34.5/40，闭环成立；工具保留可复跑。
- 数据问题（P1 新增）：data/consensus-points/source_1775446837778.json 与 source_1775446837879.json 第一题分组与题干错对齐（混入无关要点，疑为 extract-answer-points/build-consensus-points 上游对齐问题），本轮未修。
- 待办（P1 不变）：共识对齐扩量到更多可对齐卷；用真实题补 30–50 条 evaluate-skill 行为回归用例（同义改写≥抄字面、漏共识点降档、参考漏写材料支持不冤枉）。
