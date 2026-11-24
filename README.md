# Bilibili 断片修复 · 油猴脚本

解决 B 站视频播放到中间某段时，因为分片没加载成功而**直接跳过**、导致声音和画面不连续的问题。脚本会把“跳过”改成“暂停等待加载”，并增强分片重试；同一片段重试超过 10 次后弹窗询问是否继续。

- 脚本文件：`bilibili-loader-fix.user.js`
- 适用页面：`www.bilibili.com/video/*`、`/bangumi/play/*`、`/list/*`、`/medialist/play/*`、`/cheese/play/*`
- 运行时机：`document-start`（必须早于 B 站播放器脚本）

---

## 一、问题分析

以下结论来自对 B 站播放页实际加载的播放器核心 `core.js`（约 2.1 MB）的静态分析和浏览器实测，不是猜测。

### 1. 播放器架构

B 站新版 BPX 播放器内部使用的是**定制版 dash.js**：

- 播放器脚本入口：`s1.hdslb.com/bfs/static/player/main/core.<hash>.js`
- 播放页通过动态 `<script>` 加载 dash.js，并挂到 `window.dashjs`
- `DashPlayer.createPlayer()` 中执行：

  ```js
  var r = window.dashjs;
  var o = r.MediaPlayer().create();
  this.player = o;
  ```

- 视频/音频流是 fMP4 分片（`.m4s`），使用 `SegmentBase` 模式：

  ```json
  {
    "base_url": "https://.../xxx-1-30080.m4s?...",
    "segment_base": {
      "initialization": "0-1085",
      "index_range": "1086-1633"
    }
  }
  ```

  播放器先请求 init + sidx 索引，然后按字节 Range 拉取后续媒体分片。CDN 域名可能是 `*.bilivideo.com`、`*.mcdn.bilivideo.cn`、`*.edge.mountaintoys.cn` 等，所以不能只按域名识别分片。

### 2. 分片加载与重试

分片请求由 dash.js 的 `HTTPLoader` 发出，核心重试逻辑在 `J(n, r, g)` 中：

- `r`：本次请求剩余重试次数
- `g`：当前第几次重试
- 失败后执行 `r--`，延迟一段时间后递归调用 `J(n, r, g)` 继续重试
- 请求对象带有 `urls` 数组时，会按 `g` 轮换备用线路
- 重试耗尽后调用 `downloadError(...)`，该分片被放弃

也就是说，B 站本身有重试，但默认次数有限（通常是 3 次左右）。网络抖动稍长，分片就会被放弃，`buffered` 中留下空洞。

### 3. 为什么播放时会“直接跳过”

dash.js 里有两个会**主动 seek** 的机制，它们才是“跳过”的直接原因：

**（1）`PREDICT_SEEK`：预判跳段**

`PlaybackController` 中有一段逻辑：当前缓冲区间剩余不足 **0.5 秒**，且后面存在长度至少 1 秒的缓冲区间时，直接跳到下一个区间的起点。日志原文：

```
Gap has been prdiected,seek from <当前时间> to <下一个区间起点>
```

**（2）`JUMP_MEDIA_GAP`：检测到不连续后跳段**

`StreamController` 检测到 media gap / discontinuity 时会执行 `H.seek(l)`。日志原文：

```
Jumping media gap (discontinuity) at time <时间>. Jumping to time position <目标>
```

这两个行为由 dash.js 的 `getJumpGaps()` 开关控制，而 B 站在播放器初始化时写死了：

```js
i.setJumpGaps(!0);   // true
```

所以默认情况下，只要分片缺失，播放器就会“很聪明”地跳过去，而不是停下来等。

### 4. 可用的修复接口

通过接管 `window.dashjs.MediaPlayer().create()` 返回的实例，可以直接调用：

| 方法 | 作用 |
| --- | --- |
| `setJumpGaps(false)` | 关闭主动跳段 |
| `setFragmentLoaderRetryAttempts(n)` | 修改媒体分片重试次数 |
| `setFragmentLoaderRetryInterval(ms)` | 修改重试间隔 |
| `on('requestRetryed', fn)` | 监听每次分片重试，事件含 `retryTimes`、`url`、`range`、`mediaType` |
| `on('predictSeek', fn)` | 监听预判跳段 |
| `on('jumpMediaGap', fn)` | 监听实际跳段 |

以上接口均已在本机 Chrome + 实际 B 站播放页中验证可用。

---

## 二、脚本做了什么

脚本分三层工作：

### 第一层：从源头关闭跳段

在 `document-start` 拦截 `window.dashjs`，包装 `MediaPlayer` 的 `create()`，拿到 dash.js 核心实例后：

- 包装 `setJumpGaps`，强制返回 `false`。即使 B 站随后再次调用 `setJumpGaps(true)`，也会被改回 `false`。
- 主动调用 `setJumpGaps(false)`。

这样播放器不会在缓冲剩余 0.5 秒时主动跳到下一段，而是让浏览器自然进入 `waiting` 状态，停在缺失片段前等待。

### 第二层：增强重试 + 弹窗

- 包装 `setFragmentLoaderRetryAttempts`，把分片重试次数至少抬到 **10 次**（可在设置面板修改）。
- 固定重试间隔（默认 1000 ms）。
- 监听 `requestRetryed`：
  - 状态条显示“片段加载失败，正在重试 n/10”
  - 当 `retryTimes >= 10` 时弹窗：
    - **继续重试**：上限 +10，保存设置，并重新请求当前片段
    - **跳过这一段**：seek 到下一个已缓冲区间
    - **暂停等待**：暂停在当前时间，等待加载

### 第三层：`currentTime` 兜底拦截

即使因为 B 站改版、脚本注入时机等原因没能接管 dash.js，脚本还会 hook：

- `HTMLMediaElement.prototype.currentTime` 的 setter
- `HTMLMediaElement.prototype.fastSeek`

当满足以下条件时，判定为“播放器想跳过未加载片段”，拦截这次 seek 并暂停：

- 目标是向前跳 1.2 秒以上
- 当前缓冲区间剩余不足 1.5 秒
- 目标在当前缓冲区间结束之后
- 不是用户主动拖动进度条/按方向键（用户操作后有 2 秒放行窗口）

另外，`timeupdate` 中会提前检查前方是否存在缓冲空洞（当前区间剩余不足 0.8 秒，且下一个区间起点至少晚 0.3 秒），提前暂停，避免播放器触发跳段。

### 等待与恢复

暂停后会：

- 每 500 ms 检查缺失区间是否已经补上
- 补上后自动恢复播放（如果暂停前正在播放）
- 超过 15 秒仍未加载成功，弹窗询问：
  - **继续等待**
  - **跳过这一段**
  - **刷新页面**

---

## 三、安装

1. 安装用户脚本管理器：Tampermonkey（篡改猴）、Violentmonkey（暴力猴）或 ScriptCat。
2. 打开管理器的“新建脚本”，把 `bilibili-loader-fix.user.js` 的全部内容粘贴进去。
3. 保存并启用。
4. 打开任意 B 站视频页，右下角出现“断片守护”状态条即表示生效。
5. 如果之前已经打开视频页，刷新一次页面。

> 脚本使用 `@grant none`，必须运行在页面上下文中才能访问 `window.dashjs`。请不要改成 `@grant unsafeWindow` 以外的沙箱模式。

---

## 四、配置

点击右下角状态条，或按 `Alt+B`，打开设置面板：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| 最大重试次数 | 10 | 单个分片的最大重试次数；达到后弹窗 |
| 重试间隔 | 1000 ms | dash.js 分片重试基础间隔 |
| 等待超时 | 15 秒 | 暂停等待超过该时间后弹窗 |
| 关闭播放器预判跳段 | 开启 | 包装 `setJumpGaps`，强制关闭主动跳段 |
| 检测到跳段时自动暂停 | 开启 | 启用 `currentTime` 拦截和前方空洞检测 |
| 显示右下角状态条 | 开启 | 关闭后仍可用 `Alt+B` 打开设置 |
| 调试日志 | 关闭 | 开启后在控制台输出 `[BiliFix]` 日志 |

配置保存在 `localStorage` 的 `bili_loader_fix_config_v1` 中，B 站页面之间共享。

---

## 五、调试

在任意 B 站视频页的控制台：

```js
// 当前配置
window.__biliFix.config

// 内部状态，包括是否拿到 dash.js 核心实例
window.__biliFix.state

// dash.js 核心实例（拿到后才有）
window.__biliFix.state.core

// 确认 jumpGaps 是否已关闭
window.__biliFix.state.core?.getJumpGaps?.()

// 确认 dash.js 是否已被接管
window.dashjs?.__biliFixPatched

// 手动测试弹窗
window.__biliFix.showRetryDialog(
  { url: 'test', range: '0-100', mediaType: 'video', retryTimes: 10 },
  10,
  'test-key'
)
```

如果状态条出现但 `state.core` 为空，说明脚本注入晚于播放器创建。刷新页面通常可以解决；如果仍然为空，说明 B 站播放器版本变化，`window.dashjs` 或 `MediaPlayer` 的结构已改变，需要更新脚本中的接管逻辑。此时 `currentTime` 拦截仍会作为兜底生效，但重试次数和 `jumpGaps` 无法修改。

---

## 六、已知限制

1. **播放器改版风险**：脚本依赖 dash.js 的 `setJumpGaps`、`setFragmentLoaderRetryAttempts` 和 `requestRetryed` 事件。B 站更新播放器后，这些内部接口可能改名或移除。
2. **不是网络修复**：脚本只改变播放器的行为，不能修复 CDN 故障、DNS 污染或本地网络问题。
3. **URL 过期**：如果分片 URL 因 `deadline` 过期返回 403，重试同一个 URL 不会成功；脚本会通过重新 seek 让播放器尝试重新取流，但不保证一定恢复。
4. **长时间等待**：关闭 `jumpGaps` 后，如果缺失片段永远加载不上，视频会停在空洞前等待，直到超时弹窗。你可以选择“跳过这一段”继续观看。
5. **直播/互动视频/DRM**：这些场景可能使用不同的播放路径，脚本未做针对性适配。
6. **多个视频元素**：脚本只守护页面上被识别为主播放器的第一个 `video`；广告、预览等次要视频不会被拦截。
7. **全屏 UI**：B 站自定义全屏时状态条和弹窗会跟随进入全屏；原生 video 全屏时 UI 会留在页面上，但视频本身不受影响。

---

## 七、实现依据摘要

| 证据 | 位置/日志 |
| --- | --- |
| 定制版 dash.js，`window.dashjs` 全局 | `DashPlayer.createPlayer()` |
| SegmentBase + Range 拉取 `.m4s` | `SegmentBaseLoader`、`HTTPLoader` |
| 分片重试 `J(n, r, g)`，每次 `r--` | `HTTPLoader` |
| 预判跳段 | 日志 `Gap has been prdiected,seek from ...` |
| 不连续跳段 | 日志 `Jumping media gap (discontinuity) at time ...` |
| 默认开启跳段 | `i.setJumpGaps(!0)` |
| 重试事件 | `requestRetryed`，含 `retryTimes` |
| 跳段事件 | `predictSeek`、`jumpMediaGap` |

---

## 八、免责声明

本脚本仅用于改善个人观看体验，不修改 B 站服务器数据，不绕过付费/DRM/地区限制。请遵守 B 站用户协议和当地法律法规。
