# 应用图标

阶梯式 C 标识，蓝绿渐变配深蓝圆角底板。用于 Codex Usage Details 的应用窗口、任务栏、安装/卸载程序、网页页签与页头。

## 成品与源稿

- `src/assets/app-icon.svg`：1024×1024 主矢量源，背景和字母各有独立分组。
- `src/assets/app-icon-small.svg`：16–32px 使用的简化源，移除渐变和细小台阶。
- `build/app-icon.ico`：内含 16、20、24、32、40、48、64、128、256px，32 位 RGBA。
- `build/app-icon.png`：1024px 透明 PNG；底板外部为真实透明。
- `build/icons/app-icon-*.png`：各原生尺寸导出，另含 512px 与 1024px。
- `src/assets/app-icon.png`：128px 页头素材。
- `design/app-icon-preview.png`：大图与深浅背景下的原生尺寸预览。

常规应用构建直接使用已提交的图标，无需安装图像处理依赖。现有默认 Electron 素材保留为旧稿，产品引用均已切换。

## 重新导出

先修改对应 SVG，再使用 Node.js 与 Sharp 运行：

```powershell
npm install --no-save --package-lock=false sharp
node scripts/generate-icons.cjs
```

也可设置 `ICON_SHARP_MODULE` 指向已有 Sharp 模块目录，复用本机工具，无需向项目安装依赖。

导出脚本会生成全部 PNG、ICO 和预览图。打包时 `package.json` 与 Electron 主进程统一引用 `build/app-icon.ico`。
