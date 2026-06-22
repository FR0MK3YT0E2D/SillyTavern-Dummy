# Dummy（SillyTavern UI 扩展）

让酒馆在 AI 输出为空（或低于最短字符数）时自动重试的小助手。检测到空回后会执行 `/regenerate` 重刷，并设有重试上限，避免无限循环。

## 一键安装（推荐）

**前提**：运行酒馆的那台电脑需已安装 [Git](https://git-scm.com/downloads)。

1. 打开 SillyTavern → **Extensions（立方体）**
2. 点击 **Install extension**（云端下载图标）
3. 粘贴扩展的 **Git 仓库地址**：
   ```
   https://github.com/FR0MK3YT0E2D/SillyTavern-Dummy
   ```
4. 点击 **Save**，等待安装完成
5. **Manage extensions** → 勾选启用 **Dummy**
6. 刷新页面（若未自动加载）

之后可在 Extensions 抽屉调整重试次数、延迟等设置。

## 手动安装

1. 复制本文件夹到：

   ```
   public/scripts/extensions/third-party/SillyTavern-Dummy/
   ```

   或（仅当前用户）：

   ```
   data/default-user/extensions/SillyTavern-Dummy/
   ```

2. 刷新 → **Manage extensions** → 勾选启用 Dummy。

## 使用

1. 在 **Extensions 抽屉** 右侧展开 **Dummy — 空回自动重刷**。
2. 确认「启用空回自动重刷」已勾选。
3. 可调：**最多重试次数**、**解锁后缓冲**（默认 100 ms）、**额外延迟**、**最短有效字符数**。

## 注意

- 只检查**角色消息**；连续空回达上限会停止并可选 toastr 提示。
- 纯 API 连接失败、未建立楼层的情况，本扩展无法处理（需另行处理网络 / fetch 重试）。

## 授权

AGPL-3.0（与 SillyTavern 生态一致）。
