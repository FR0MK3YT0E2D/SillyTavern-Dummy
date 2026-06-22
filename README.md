# Dummy（SillyTavern UI 扩展）v1.2.2

让酒馆在 AI **输出为空**时自动 `/regenerate` 重刷，在 **回复被截断**时自动 `/continue` 续写。

## 一键安装

```
https://github.com/FR0MK3YT0E2D/SillyTavern-Dummy
```

Extensions → Install extension → Save → Manage extensions 勾选 **Dummy**

须通过酒館 **Install extension（Git）** 安装，才能使用面板内的**检查更新**与后台自动更新（依赖 Git 仓库）。

## 功能

- **空回自动重刷**：空白回复 → `/regenerate`
- **截断自动续写**：`finish_reason` 或启发式检测 → `/continue`，无增量会重试
- **v1.2.1+ 自动更新**：显示版本号、手动「检查更新」、可配置后台定期检查并自动 `git pull`
- **v1.2.2 面板 UI**：总览 / 空回 / 续写 / 更新 分页，主题色卡片与开关

## 授权

[MIT License](LICENSE.md) · Copyright (c) 2026 FR0MK3YT0E2D
