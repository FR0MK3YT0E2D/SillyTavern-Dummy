# Dummy（SillyTavern UI 扩展）v1.3.0

让酒馆在 AI **输出为空**时自动 `/regenerate` 重刷，在 **回复被截断**时自动 `/continue` 续写，在 **断流 / 超时 / 无回复**时自动重试。

## 一键安装

```
https://github.com/FR0MK3YT0E2D/SillyTavern-Dummy
```

Extensions → Install extension → Save → Manage extensions 勾选 **Dummy**

须通过酒館 **Install extension（Git）** 安装，才能使用面板内的**检查更新**与后台自动更新（依赖 Git 仓库）。

## 功能

- **空回自动重刷**：空白回复 → `/regenerate`
- **断流自动重试**：生成超时、完全无回复时自动重刷；可过滤 MVU 标签与 API 请求末尾
- **截断自动续写**：`finish_reason` 或启发式检测 → `/continue`，无增量会重试
- **兼容模式**：可与酒馆助手「自动重试」类脚本并存，避免重复重刷
- **面板 UI**：总览 / 空回 / 断流 / 续写 / 更新 分页

## 授权

[MIT License](LICENSE.md) · Copyright (c) 2026 FR0MK3YT0E2D
