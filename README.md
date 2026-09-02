# Codex Usage Details

一个面向 Windows 的桌面用量面板，用于聚合多个账户并分别查看官方 API 用量与 Codex 订阅用量。

## 当前状态

当前版本已经接入真实数据链路，同时保留浏览器预览模式。Electron 桌面应用中的账户数据通过官方接口读取；首次启动且没有账户时显示连接引导，不会自动生成假数据。浏览器预览模式仍使用脱敏的确定性演示数据，方便查看 UI。

已实现：

- API 用量与订阅用量两个独立视图
- 多账户列表与账户切换入口
- 24 小时、7 天、30 天、全部四种时间范围
- 按模型排列的请求次数曲线和 Token 堆叠柱状图（API 与本机 Codex 会话均支持）
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

环境要求：Node.js 20 或更高版本。Windows 桌面开发不要求安装 Rust。

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

开发环境需要 Node.js 20 或更高版本。普通用户不需要安装 Node.js，直接使用 GitHub Releases 中的 Windows 安装包即可。

## 安装与使用

1. 从 GitHub Releases 下载最新的 Windows 安装包。
2. 安装并启动 `Codex Usage Details`。
3. 在“管理账户”中添加组织管理员 API Key，或使用官方 OAuth 登录订阅账户。
4. 订阅账户如果使用了非默认的 Codex 数据目录，在账户管理中为该账户选择对应目录。

API 用量接口要求组织管理员权限。订阅额度登录使用官方 OAuth，但订阅接口不是公开稳定 API，接口变更时需要等待适配更新。

## 隐私与安全

- API Key 和 OAuth Token 只由 Electron 主进程处理，并使用操作系统安全存储加密。
- 前端不会直接接触完整凭据，preload 只暴露受限的账户和用量方法。
- API 请求直接发送到 OpenAI 官方域名，不经过本项目的第三方服务器。
- 订阅模型明细从用户指定的本机 Codex `.jsonl` 会话日志读取，只解析模型、时间和 Token 事件，不上传对话内容。
- 应用不会自动读取其他用户的 Codex 目录。
- 删除订阅账户时会先请求官方 OAuth revoke，成功后才删除本地账户记录。

## 已知限制

- 当前项目只提供 Windows 桌面安装包，浏览器模式仅用于 UI 预览。
- `/wham/usage` 属于订阅服务内部接口，字段和路径可能随官方服务变化。
- 订阅额度是当前窗口数据，订阅历史模型明细依赖本机 Codex 会话日志。
- 费用估算默认使用 Standard 文本价格，不包含 Batch、Fast、区域处理、工具、图片、音频和其他非 Token 费用。
- 无法匹配价格表的模型会被单独标记，不会静默按零费用处理。

## 非官方声明

本项目是非官方社区工具，不代表 OpenAI。OpenAI、ChatGPT 和 Codex 等名称及商标归其各自所有者所有。官方接口、OAuth 流程和服务策略发生变化时，本项目可能暂时无法使用。

## 数据源设计

API 用量和订阅用量使用独立的 `UsageProvider` 数据契约，避免把两套不同认证体系混为一体。

- 官方 API 用量：接入组织级 `/v1/organization/usage/completions`，需要组织管理员 API Key。请求按模型分组，按最近 24 小时每小时或其他范围每天聚合，并映射输入缓存命中、未命中、输出和请求数。
- 费用估算：按官方价格页的标准文本价格计算，公式为 `未命中输入 Token × 输入单价 + 缓存命中输入 Token × 缓存输入单价 + 缓存写入 Token × 缓存写入单价 + 输出 Token × 输出单价`，价格单位为 USD / 1M tokens。当前价格表核验日期为 `2026-09-01`，来源为 <https://developers.openai.com/api/docs/pricing/>。
- 费用范围：估算默认使用 Standard 价格，不包含 Fast、Batch、区域处理加价、工具调用、图片、音频和其他非 Token 费用。无法匹配的模型会单独提示，不按零费用处理。
- 官方订阅用量：复用官方开源 Codex CLI 当前的 OAuth 参数、PKCE 本地回调和 Token 刷新方式，读取 ChatGPT 后端的 `/wham/usage`。
- 订阅接口边界：`/wham/usage` 当前返回实时套餐额度窗口、重置时间和计划类型，不返回历史按模型 Token 曲线；订阅页的模型明细来自 `~/.codex/sessions/**/*.jsonl` 本机会话日志，只读取模型、时间和 Token 事件，不读取对话内容。
- 用户目录：Windows 默认读取 `%USERPROFILE%\\.codex\\sessions`，macOS/Linux 默认读取 `~/.codex/sessions`；设置 `CODEX_HOME` 后改为读取 `${CODEX_HOME}/sessions`。应用不会写入其他用户的目录。
- 多账户日志：首次连接订阅账户使用当前用户的默认 Codex 目录；如果不同账户使用不同 `CODEX_HOME`，可在“管理账户”中为每个订阅账户选择对应的数据目录。
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
