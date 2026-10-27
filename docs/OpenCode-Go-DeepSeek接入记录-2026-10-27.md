# OpenCode Go DeepSeek 手机网站接入（2026-10-27）

目标：网站共享文本模型使用站主 OpenCode Go API，通过云端 Worker 直连，朋友手机无需配置 Key，也不需要站主电脑持续运行。

## 代码与验证

- `server/opencode-go.cjs` 固定官方端点 `https://opencode.ai/inference/go/openai/v1/chat/completions`、`deepseek-v4.1-flash`；如实标识 User-Agent `ShenlunGrader/1.0`，按账号与会话首条消息生成稳定哈希 session header。
- Worker/Node：仅在配置 Go Key 后选用直连；不接受共享凭据下的客户端模型/地址覆盖，保留登录与 Origin 校验。用户自带 Key 保留原路径。
- 拍照识别保留原视觉服务；若没有视觉配置，明确提示先粘贴文字。没有将 DeepSeek 图片输入能力标为已验证。
- 前端区分 `opencode-go-api` 云端直连与原 `opencode-go` 本机桥接，不再把云端 API 描述为需要电脑开机。
- 新配置名 `OPENCODE_GO_API_KEY`，不覆盖原 `ZHIPU_API_KEY`。本地可使用 `.runtime/opencode-go.json`；不得写入 site/、源码或发布包。

已运行：Worker Go 契约 21 项、Node Go HTTP 集成、原模型策略 12 项、原桥接回归、账号 63 项、站点 14 项、前端 API 契约、发布包关键流程 28 项。均通过；这些使用假上游。

新发布包 `.agent/site-release-20261027-go/`：371 套题库、467 个静态文件、11 个固定后端/迁移文件，完整性检查及 Wrangler 4.152.0 dry-run 通过。未发布；旧 20261026 包保留。

## 真实 Go 测试与阻塞

本机 OpenCode 凭据存储中存在 opencode-go key，但本轮仅一次真实请求返回：HTTP 401，`Upstream request failed: Invalid credential`。未打印、复制到报告或修改该旧凭据，不再重复使用它请求。

结果文件：`output/opencode-go-20261027/direct-probe.json`，只含状态、耗时及去敏错误；没有成功输出，不能称 Go 已连通。不能据此证明订阅不足或余额耗尽，当前只确定凭据被拒绝。

已提供 `node tools/setup-opencode-go.cjs` 本机录入工具：127.0.0.1 随机端口，20 分钟有效，密码输入框，Origin/Host/nonce 检查。用户亲自输入新 Key，向官方 API 验证，只有返回非空正文才保存到被忽略的 `.runtime/opencode-go.json`。此工具不设置云端 secret、不部署。

本轮启动页地址见 `.runtime/opencode-go-setup-url.json`。过期后重新运行该工具，勿将 Key 发到聊天。页面 GET 200/no-store、跨站 POST 403 已验证；用户实际提交新 Key 的结果尚未发生。

## 后续

1. 用户本机录入有效 Go Key，确认真实请求成功并检查 `.runtime/opencode-go-setup-result.json` 的非敏感结果。
2. 用新的 Go API 跑一篇实际批改，确认完整正文/分数、超时和流式行为。不得把旧本机 OpenCode 桥接成功等同新 API 成功。
3. 经用户明确授权发布后，把有效 Key 通过 stdin 写入 Cloudflare `OPENCODE_GO_API_KEY` Secret，部署本轮新包；核对生产健康接口 provider/model 和普通账号实际批改。不要将 Key 放进命令参数、聊天、日志或静态文件。
4. 朋友蜂窝网络及微信内置浏览器验收。平台凭据轮换事项仍按 10-26 报告，不擅自撤销现有生产 Key。

## 官方依据与适用边界

- [OpenCode Go](https://opencode.ai/v2/docs/console/go)：模型接口表列 DeepSeek V4.1 Flash，要求自有客户端标识与稳定会话 ID；Go 主要面向编程代理与典型编程流量。
- [Inference API](https://opencode.ai/v2/docs/console/api/inference)：其他客户端可使用付费模型或 Go 订阅；免费模型不等于通用免费 API。

申论批改属于非编程用途，需要向 OpenCode 确认该订阅是否适用。本次没有伪装编程请求、绕过供应商校验或把技术接入测试当作供应商对该用途的批准。
