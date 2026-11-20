# Codex Usage Details

一个面向 Windows 的桌面用量面板，用于聚合多个账户并分别查看官方 API 用量与 Codex 订阅用量。

## 当前状态

当前版本已经接入真实数据链路，同时保留浏览器预览模式。Electron 桌面应用中的账户数据通过官方接口读取；首次启动且没有账户时显示连接引导，不会自动生成假数据。浏览器预览模式仍使用脱敏的确定性演示数据，方便查看 UI。

已实现：

- 请求与订阅视图显示数据取得时间，缓存有效期为 60 秒，桌面端每分钟自动刷新
- 模型汇总表支持排序与选择，长时间范围自动按周、月或季度汇总
- 按参考图设计近黑背景、紫色额度进度条、四张彩色顶边指标卡；默认展示 24 小时用量，顶部可切换时间范围及刷新
- “账户与筛选”展开来源、账户及模型选择；摘要与逐模型图表同步联动，当前模型筛选保持可见并支持一键清除
- 每个模型依次展示 Token 堆叠柱状图与请求／用量记录折线图；五色图例、鼠标悬浮及键盘明细保留，图表宽度和坐标文字随窗口适配
- Pro 展示实际周额度，过滤遗留的 5 小时窗口；接口未返回额度窗口时显示缺失状态
- 支持 GPT-6.2 Astra / Sol 的 Standard、Fast、Ultrafast 费用估算，以及其他 GPT-6 系列和历史 Codex 模型的价格折算
- 官方 GET 请求短暂断连时自动重试一次；未配置或无法读取日志时，模型指标显示为 `--`
- Token 输出已包含推理；费用缺价、日志错误与扫描限制会单独提示
- 本机日志通过工作线程流式读取，未变化文件复用解析结果

- API 用量与订阅用量两个独立视图
- 多账户列表与账户切换入口
- 24 小时、7 天、30 天、全部四种时间范围
- 按模型排列的请求次数曲线和 Token 堆叠柱状图（API 与本机 Codex 会话均支持）
- 仅统计 OpenAI 模型；当前识别 GPT、o1/o3/o4、Codex、ChatGPT 和对应 fine-tune 模型标识
- 图表悬浮明细
- 请求次数坐标轴按 5 / 0 结尾的分度值智能调整
- Token 坐标轴按 K、M、B 单位智能调整
- 按当前系统用户自动定位 Codex 数据目录，支持 `CODEX_HOME`
- 每个订阅账户可单独选择 Codex 日志目录，避免多账户日志混合
- Electron 安全窗口配置：关闭 Node 集成并启用上下文隔离
- 官方 Codex CLI 风格的 PKCE OAuth 登录和本机回调
- API Key 与 OAuth Token 的操作系统安全存储
- API 用量官方 provider 和订阅额度兼容性 provider
- OAuth access token 自动刷新和账户切换
- 按 OpenAI 官方标准 API 价格计算的费用估算

## 开发

环境要求：Node.js 22.12 或更高版本。Windows 桌面开发不要求安装 Rust。

```bash
npm install
npm run dev
```

检查类型并构建前端：

```bash
npm run typecheck
npm run build
```

生产构建后的前端可以使用 `npm start` 在 Electron 中打开。生成 Windows 安装包：

```bash
npm run package
```

开发环境需要 Node.js 22.12 或更高版本。普通用户不需要安装 Node.js，直接使用 GitHub Releases 中的 Windows 安装包即可。

## 安装与使用

1. 从 GitHub Releases 下载最新的 Windows 安装包。
2. 安装并启动 `Codex Usage Details`。
3. 在“管理账户”中添加组织管理员 API Key，或使用官方 OAuth 登录订阅账户。
4. 在账户管理中为订阅账户选择独立使用的 Codex 数据目录，并确认日志归属。未选择目录时仍显示官方额度，不统计本机模型记录。旧版本使用默认目录的账户也需要执行此步骤；已明确配置的目录会保留。

API 用量接口要求组织管理员权限。订阅额度登录使用官方 OAuth，但订阅接口不是公开稳定 API，接口变更时需要等待适配更新。

## 隐私与安全

- API Key 和 OAuth Token 只由 Electron 主进程处理，并使用操作系统安全存储加密。
- 前端不会直接接触完整凭据，preload 只暴露受限的账户和用量方法。
- API 请求直接发送到 OpenAI 官方域名，不经过本项目的第三方服务器。
- 订阅模型明细从用户指定的本机 Codex `.jsonl` 会话日志读取，只解析模型、时间和 Token 事件，不上传对话内容。
- 本机日志按 64 KiB 数据块流式读取，单个会话超过 64 MiB、总日志超过 512 MiB 也会纳入统计；超长行只保留统计所需字段，避免将整段图片或工具输出装入内存。未变化的会话复用文件缓存。
- 应用不会自动读取其他用户的 Codex 目录。
- 删除订阅账户时会先请求官方 OAuth revoke，成功后才删除本地账户记录。

## 已知限制

- 当前项目只提供 Windows 桌面安装包，浏览器模式仅用于 UI 预览。
- `/wham/usage` 属于订阅服务内部接口，字段和路径可能随官方服务变化。
- 订阅额度是当前窗口数据，订阅历史模型明细依赖本机 Codex 会话日志。
- 本机扫描保留 10,000 个日志文件及 32 层目录的上限；读取失败、格式不完整或扫描未完成时会提示。
- 费用估算采用短上下文文本价格（有分档的模型按 ≤272K 输入档）。GPT-6.2 API 用量明确记录的 12 小时缓存写入按对应单价估算，其余写入按 30 分钟单价折算。
- 无法匹配价格表的模型会被单独标记，不会静默按零费用处理。
- 本机 Codex 日志通常只包含模型名称，不包含供应商字段；如果第三方服务伪装成 OpenAI 模型名称，应用无法仅凭名称识别来源。

## 非官方声明

本项目是非官方社区工具，不代表 OpenAI。OpenAI、ChatGPT 和 Codex 等名称及商标归其各自所有者所有。官方接口、OAuth 流程和服务策略发生变化时，本项目可能暂时无法使用。

## 数据源设计

API 用量和订阅用量使用独立的 `UsageProvider` 数据契约，避免把两套不同认证体系混为一体。

- 官方 API 用量按 `model` 和 `service_tier` 查询组织级 `/v1/organization/usage/completions`，需要组织管理员 API Key。时间粒度为最近 24 小时按小时、其他范围按天，同一时段的输入、输出和请求数按模型汇总。[OpenAI 用量接口](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions)
- 费用估算将各档位的 `未命中输入 Token × 输入单价 + 缓存命中输入 Token × 缓存输入单价 + 缓存写入 Token × 缓存写入单价 + 输出 Token × 输出单价` 求和，再除以 `1,000,000`。价格单位为 USD / 1M tokens，核验日期为 `2026-11-18`。[OpenAI 官方价格页](https://developers.openai.com/api/docs/pricing/)
- GPT-6.2 Astra 和 Sol 的 Fast 费率为 Standard 的 2 倍。Ultrafast 在美国太平洋时间 2027 年 3 月 1 日零点前按 3 倍估算，此后按 6 倍估算。API 用量按接口返回的档位取价，订阅用量按本机日志记录的请求设置折算。缺少模式记录时使用 Standard。[OpenAI 官方价格页](https://developers.openai.com/api/docs/pricing/)
- 历史 Codex 价格：保留官方模型文档中的 [GPT-5.2-Codex](https://developers.openai.com/api/docs/models/gpt-5.2-codex)、[GPT-5.1-Codex](https://developers.openai.com/api/docs/models/gpt-5.1-codex)、[GPT-5.1-Codex-Max / GPT-5-Codex](https://developers.openai.com/api/docs/models/gpt-5.1-codex-max)、[GPT-5.1-Codex-Mini](https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini) 价格，用于历史记录估算。
- 无法匹配模型价格或缺少缓存写入单价时，面板会标记未计价的模型。
- 官方订阅用量：复用官方开源 Codex CLI 当前的 OAuth 参数、PKCE 本地回调和 Token 刷新方式，读取 ChatGPT 后端的 `/wham/usage`。
- Pro 额度：按 [OpenAI 当前说明](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex)，Pro 100 / 200 / 500 无 5 小时用量限额；页面保留接口返回的周额度及其他有效时长，额度窗口缺失时不生成使用率。演示模式同样只展示 Pro 周额度。
- 订阅接口边界：`/wham/usage` 当前返回实时套餐额度窗口、重置时间和计划类型，不返回历史按模型 Token 曲线；订阅页的模型明细来自 `~/.codex/sessions/**/*.jsonl` 本机会话日志，只读取模型、时间和 Token 事件，不读取对话内容。
- 用户目录：Windows 默认读取 `%USERPROFILE%\\.codex\\sessions`，macOS/Linux 默认读取 `~/.codex/sessions`；设置 `CODEX_HOME` 后改为读取 `${CODEX_HOME}/sessions`。应用不会写入其他用户的目录。
- 多账户日志：连接订阅账户后，需要在“管理账户”中选择此账户独立使用的 Codex 数据目录。默认不会扫描当前用户的全部日志；一个目录不能分配给多个账户。重新登录会保留目录设置。应用无法自动验证日志中的账户身份，归属由用户确认。
- 多账户凭据：只由 Electron 主进程处理，使用 `safeStorage` 加密后写入应用数据目录；preload 只暴露无凭据的账户摘要和受限 IPC 方法。
- 网络请求：使用 Electron `net.request` 和默认会话，遵循 Windows 系统代理；若设置了 `HTTPS_PROXY`、`HTTP_PROXY` 或 `ALL_PROXY`，应用启动时会将其用于官方请求。

订阅接口不是公开稳定 API。接口字段或路径变化时，应用应提示用户重新登录或等待适配，不应静默展示旧数据。

## 账户连接

- API 账户：输入组织管理员 API Key，可选填组织 ID。API Key 只会通过受限 IPC 传给主进程。
- 订阅账户：应用打开系统浏览器进行官方 OAuth 登录，回调只监听本机 `1455` 端口，冲突时使用官方 CLI 注册的 `1457` 端口。
- Windows 部署：安装包使用 per-user 安装模式，并由 NSIS 为安装用户创建桌面和开始菜单快捷方式，不依赖开发者机器上的绝对路径。
- 删除订阅账户时，应用先请求官方 OAuth revoke，成功后才删除本地加密记录；API 账户只删除本地 API Key。

## 许可证

本项目使用 MIT 许可证，详见 [LICENSE](./LICENSE)。
