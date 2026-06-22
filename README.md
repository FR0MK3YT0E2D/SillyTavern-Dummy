# Dummy（SillyTavern UI 扩展）v1.1.0

让酒馆在 AI **输出为空**时自动 `/regenerate` 重刷，在 **回复被截断**（未正常结束）时自动 `/continue` 续写。

## 一键安装（推荐）

**前提**：运行酒馆的那台电脑需已安装 [Git](https://git-scm.com/downloads)。

1. 打开 SillyTavern → **Extensions（立方体）**
2. 点击 **Install extension**
3. 粘贴仓库地址：
   ```
   https://github.com/FR0MK3YT0E2D/SillyTavern-Dummy
   ```
4. **Save** → **Manage extensions** 勾选 **Dummy** → 刷新页面

## 功能

### 空回自动重刷

角色回复空白（或低于最短字符数）→ 自动 `/regenerate`。

### 截断自动续写（v1.1.0）

在生成结束后检测是否被截断，自动 `/continue`：

| 检测方式 | 说明 |
|----------|------|
| **API finish_reason** | 拦截生成请求响应，识别 `length`、`max_tokens`、`content_filter`、`SAFETY` 等（OpenAI 兼容 / Gemini 等） |
| **未正常收束** | 回复较长但以逗号、未闭合标签等结尾，启发式判定为写到一半 |
| **续写无增量** | `/continue` 后字数没增加，会继续尝试（直到达上限） |

均有独立重试上限，避免死循环。

## 使用

Extensions 抽屉 → **Dummy — 空回重刷 / 截断续写**，按需开关与调参。

## 注意

- 流式与非流式生成均会尝试读取 API 元数据；部分后端不返回 `finish_reason` 时，仍可依「未收束」启发式判断。
- 纯连接失败、未建立楼层时本扩展无法处理。
- 群聊暂未专门优化。

## 授权

[MIT License](LICENSE.md) · Copyright (c) 2026 FR0MK3YT0E2D
