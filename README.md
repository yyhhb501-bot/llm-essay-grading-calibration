# 申论朱批

LLM-based Essay Grading and Score-Calibration System

[进入批改网站](https://shenlundawang.asia/) · [研究与数据状态](https://yyhhb501-bot.github.io/llm-essay-grading-calibration/site/research.html) · [校准复现说明](calibration/README.md)

基于题目、给定材料和考生作答的申论练习网站，提供结构化评分、逐条批注、解题陪练、真题库与备考计划。支持账号登录、共享模型及自带 API Key。分数仅供练习参考，不是官方阅卷结果。

**当前状态：应用与校准流程已实现，真实效果待验证。** 维护者尚未提供真实人工评分样本、用户人数和提交量记录。仓库中的 2,420 行评分数据是程序生成的模拟数值，不是真实作答；此前文档中的 MAE 6.8→4.1、QWK 0.52→0.71、300 多用户、2,400 多篇提交等表述没有证据支持，已撤下。模拟数据不能复现真实业务效果，亦不能作为简历成果。

## 功能

- 五类申论题型、材料与题目输入、流式批改、多维分数、逐句批注与修改建议；缺关键材料时要求暂不评分。
- 真题筛选与带入作答、对话陪练、备考计划、浏览器本机历史。
- 邀请注册、用户名密码、HttpOnly 会话、管理员角色；个人历史和设置按账号保存在当前浏览器，暂不跨设备同步。
- 模型共享转发与自带 Key，识图依赖所配置视觉模型的实际能力。
- Python Ridge/梯度提升树实验：题目组隔离、训练组内交叉验证、MAE/QWK、特征消融、分数段/题型/字数偏差、观测重复评分方差。
- 浏览器 Ridge 推理：仅接受经审核的人类标签模型和完整特征；默认禁用，不使用仓库模拟权重改分，不显示固定高置信度。

## 本地启动网站

Node.js **22.13+**（使用内置 `node:sqlite`），推荐 24 LTS。网站运行不需要 npm 包。

```powershell
# 用自己的邀请码；值仅在本机填写，不要提交
$env:REGISTER_INVITE_CODE = 'choose-your-local-invite'
node site-server.js
```

打开 `http://127.0.0.1:8787`，点击注册，填写刚设置的邀请码，登录后进入设置。可使用自己的模型 API，或由站主配置共享模型。没有有效模型服务凭据时，网站可以打开，但不能完成真实 AI 批改；连接测试会显示实际错误。

共享智谱服务可用环境变量 `ZHIPU_API_KEY`、`ZHIPU_MODEL` 和 `ZHIPU_VISION_MODEL`；OpenCode Go 使用 `OPENCODE_GO_API_KEY`。供应商实际返回和有效权限决定调用是否成功。不要上传 Key、账号库或 `.runtime/`。

## 复现实验

```powershell
python -m pip install -r requirements.txt
# 显式模拟演示，只验证功能
python run_calibration_repro.py --demo --output .runtime/demo-run-001
# 真正人工标签需自行提供，不随仓库发布
python run_calibration_repro.py --input path/to/human-labels.csv --data-kind human --output .runtime/human-run-001
python -m unittest discover -s calibration/tests -v
```

实验没有默认生成“人工标签”的路径。真实 CSV 的字段见 `calibration/example-schema.csv`。输出包含来源摘要、题目组切分、指标、偏差、消融和模型。没有重复评分时一致性为 null。训练脚本不自动审核标签、不自动重训、不自动发布。具体限制和接入方式见[实验说明](calibration/README.md)。

## 验证与构建

```powershell
node tools/test-auth.mjs
node tools/test-site.js
node tools/test-site-api.js
node tools/test-model-policy.mjs
node tools/test-opencode-go.mjs
node tools/build-site.js
node tools/bundle-single-html.js
```

这些网站测试使用隔离数据库与假上游，不能证明真实供应商服务可用。Python 模拟自测也不能证明真实阅卷效果。验收记录见[当前交付记录](docs/简历项目对齐与发布记录-2026-10-27.md)。

## 发布

完整网站由 Cloudflare Worker 提供静态文件、账号与模型代理，使用 D1。GitHub Pages 只承载静态研究说明，不能替代这个后端。现有生产配置在 `worker/wrangler.toml`；复用本项目的开发者应改用自己的账号、域名和 D1。

`node tools/prepare-site-release.js --out=.agent/site-release-YOUR-ID --allow-dirty` 创建独立发布包；复核 `manifest.json`、运行包内 `verify.cjs` 和关键流程测试后再部署。不得将本地缓存、凭据、真实人工标签、用户作答或账号库一起发布。

## 目录

| 路径 | 用途 |
| --- | --- |
| `site/` | 移动端网站与研究说明 |
| `site-server.js`、`server/` | 本地服务、认证、题库和模型策略 |
| `worker/` | Cloudflare Worker 与 D1 迁移 |
| `calibration/` | 显式数据输入的训练评估与自测 |
| `skill/`、`data/` | 方法论提示词、题库、明确标记的模拟数据 |
| `tools/` | 构建、隔离验收与发布工具 |
| `pages/`、`utils/` | 保留的微信小程序源码；当前优先验收网站 |

## 真实成果边界

已具备可运行代码与实验流程；独立人工标注、真实 MAE/QWK 改善、用户规模、线上自动周评估与重训、手机蜂窝网络和微信内置浏览器验收仍需另行证据。当前没有承诺特定评分准确度。使用代码时请保留题库及第三方内容来源说明；代码许可证不替代第三方内容授权。
