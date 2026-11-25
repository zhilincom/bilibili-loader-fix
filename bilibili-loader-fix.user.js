// ==UserScript==
// @name         Bilibili 断片修复 · 暂停等待加载
// @namespace    https://github.com/zhilincom/bilibili-loader-fix
// @version      1.1.0
// @description  阻止 B 站播放器跳过未加载的视频片段，改为暂停等待；分片加载失败自动重试，超过 10 次弹窗询问是否继续；支持全屏自动隐藏、运行统计和油猴菜单控制。
// @author       Lone
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/medialist/play/*
// @match        https://www.bilibili.com/cheese/play/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // @grant 模式下脚本运行在油猴沙箱中，必须通过 unsafeWindow 访问页面的
  // pageWindow.dashjs / pageWindow.HTMLMediaElement 等对象；@grant none 时回退到 window。
  const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const pageDocument = pageWindow.document;

  /* =========================================================================
   * 说明
   * -------------------------------------------------------------------------
   * B 站新版播放器（BPX）内部使用定制版 dash.js，分片为 SegmentBase + Range
   * 请求的 .m4s 文件。当某个分片下载失败且重试耗尽后，dash.js 会产生 buffer
   * 空洞；它的 StreamController / PlaybackController 会在缓冲剩余不足 0.5 秒
   * 时主动 seek 到下一个已缓冲区间（日志："Jumping media gap" /
   * "Gap has been predicted"），于是观众看到的就是“直接跳过一段”。
   *
   * 本脚本做三件事：
   *   1. 接管 pageWindow.dashjs.MediaPlayer 创建的实例，强制关闭 jumpGaps，
   *      从源头阻止“预判跳段”。
   *   2. 把分片重试次数提高到 10 次（可配置），并监听 requestRetryed；
   *      达到上限后弹窗询问是否继续重试。
   *   3. 在 pageWindow.HTMLMediaElement.currentTime 上做兜底拦截：如果播放器仍然
   *      试图跳过未加载区间，就暂停并等待，而不是让它跳过去。
   * ======================================================================= */

  const STORAGE_KEY = 'bili_loader_fix_config_v1';
  const STATS_KEY = 'bili_loader_fix_stats_v1';
  const LOG_PREFIX = '[BiliFix]';

  const DEFAULTS = Object.freeze({
    maxRetries: 10,          // 分片最大重试次数
    retryInterval: 1000,     // 重试基础间隔（毫秒）
    disableJumpGaps: true,   // 关闭 dash.js 的 jumpGaps（预判跳段）
    autoPauseOnGap: true,    // 检测到跳段时自动暂停等待
    waitTimeout: 15,         // 等待加载超时（秒）
    showStatus: true,        // 显示右下角状态条
    debug: false,            // 控制台调试日志
  });

  const config = loadConfig();

  const state = {
    core: null,                 // dash.js 核心实例
    video: null,                // 当前 video 元素
    player: null,               // pageWindow.player
    pendingGap: null,           // { from, to, at, reason }
    wasPlaying: false,
    watchdog: null,
    nudgeTimer: null,
    lastNudgeAt: 0,
    userSeekUntil: 0,
    allowSeekOnce: false,
    retryDialogKeys: new Set(),
    dialogQueue: [],
    dialogActive: false,
    statusTimer: null,
    lastGapCheck: 0,
    lastStatus: '',
    stats: loadStats(),
    fullscreenHidden: false,
    lastFullscreenState: null,
    ui: { bar: null, panel: null, dialog: null },
  };

  /* =========================================================================
   * 基础工具
   * ======================================================================= */

  function log(...args) {
    if (config.debug) console.log('%c' + LOG_PREFIX, 'color:#fb7299;font-weight:bold', ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) return '--:--';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function loadConfig() {
    const cfg = Object.assign({}, DEFAULTS);
    try {
      const raw = pageWindow.localStorage.getItem(STORAGE_KEY);
      if (!raw) return cfg;
      const parsed = JSON.parse(raw);
      for (const key of Object.keys(DEFAULTS)) {
        if (parsed && typeof parsed[key] === typeof DEFAULTS[key]) cfg[key] = parsed[key];
      }
    } catch (err) {
      /* localStorage 不可用时使用默认值 */
    }
    cfg.maxRetries = clamp(parseInt(cfg.maxRetries, 10) || DEFAULTS.maxRetries, 1, 100);
    cfg.retryInterval = clamp(parseInt(cfg.retryInterval, 10) || DEFAULTS.retryInterval, 200, 10000);
    cfg.waitTimeout = clamp(parseInt(cfg.waitTimeout, 10) || DEFAULTS.waitTimeout, 5, 120);
    return cfg;
  }

  function saveConfig() {
    try {
      pageWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
      /* 忽略写入失败 */
    }
  }

  function loadStats() {
    const stats = { retries: 0, waits: 0, blocked: 0 };
    try {
      const raw = pageWindow.localStorage.getItem(STATS_KEY);
      if (!raw) return stats;
      const parsed = JSON.parse(raw);
      stats.retries = Math.max(0, parseInt(parsed.retries, 10) || 0);
      // 兼容 1.0.0 的 gaps 字段。
      stats.waits = Math.max(0, parseInt(parsed.waits, 10) || parseInt(parsed.gaps, 10) || 0);
      stats.blocked = Math.max(0, parseInt(parsed.blocked, 10) || 0);
    } catch (err) {
      /* 统计读取失败时从 0 开始 */
    }
    return stats;
  }

  function saveStats() {
    try {
      pageWindow.localStorage.setItem(STATS_KEY, JSON.stringify(state.stats));
    } catch (err) {
      /* 忽略写入失败 */
    }
  }

  function defaultStatusText() {
    return '断片守护 · 重试 ' + state.stats.retries + ' · 等待 ' + state.stats.waits;
  }

  function bumpStat(key) {
    if (!state.stats || typeof state.stats[key] !== 'number') return;
    state.stats[key] += 1;
    saveStats();
    updateStatsUI();
    // 当前状态条显示的是默认文本时，同步刷新统计数字。
    if (!state.lastStatus || state.lastStatus.indexOf('断片守护') === 0) {
      showStatus(defaultStatusText(), 'ok', 0);
    }
  }

  function resetStats() {
    state.stats = { retries: 0, waits: 0, blocked: 0 };
    saveStats();
    updateStatsUI();
    showStatus('统计计数已重置', 'ok', 3000);
  }

  function updateStatsUI() {
    if (!state.ui.panel) return;
    const set = (id, value) => {
      const el = state.ui.panel.querySelector('#' + id);
      if (el) el.textContent = String(value);
    };
    set('bili-fix-stat-retries', state.stats.retries);
    set('bili-fix-stat-waits', state.stats.waits);
    set('bili-fix-stat-blocked', state.stats.blocked);
  }

  function getVideo() {
    if (state.video && state.video.isConnected) return state.video;
    return pageDocument.querySelector('video');
  }

  function getPlayer() {
    try {
      return pageWindow.player || null;
    } catch (err) {
      return null;
    }
  }

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function isBuffered(video, time, tolerance) {
    const tol = tolerance == null ? 0.05 : tolerance;
    if (!video || !video.buffered) return false;
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i);
        const end = video.buffered.end(i);
        if (time >= start - tol && time <= end + tol) return true;
      }
    } catch (err) {
      return false;
    }
    return false;
  }

  function getBufferedEnd(video, time) {
    if (!video || !video.buffered) return time;
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i);
        const end = video.buffered.end(i);
        if (time >= start - 0.15 && time <= end + 0.15) return end;
      }
    } catch (err) {
      /* ignore */
    }
    return time;
  }

  function getNextBufferedStart(video, end) {
    if (!video || !video.buffered) return null;
    let best = null;
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i);
        if (start > end + 0.25 && (best == null || start < best)) best = start;
      }
    } catch (err) {
      return null;
    }
    return best;
  }

  /* =========================================================================
   * UI 样式
   * ======================================================================= */

  function injectStyles() {
    if (pageDocument.getElementById('bili-fix-style')) return;
    const style = pageDocument.createElement('style');
    style.id = 'bili-fix-style';
    style.textContent = `
      #bili-fix-bar {
        position: fixed !important;
        right: 16px !important;
        bottom: 84px !important;
        z-index: 2147483646 !important;
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
        padding: 6px 12px !important;
        border-radius: 999px !important;
        background: rgba(24, 25, 28, 0.92) !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28) !important;
        color: #e3e5e7 !important;
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif !important;
        cursor: pointer !important;
        user-select: none !important;
        backdrop-filter: blur(6px) !important;
        transition: opacity .2s ease, transform .2s ease !important;
      }
      #bili-fix-bar:hover { transform: translateY(-1px) !important; }
      #bili-fix-bar .bili-fix-dot {
        width: 8px !important; height: 8px !important; border-radius: 50% !important;
        background: #2ecc71 !important; flex: 0 0 auto !important;
        box-shadow: 0 0 0 2px rgba(46, 204, 113, .15) !important;
      }
      #bili-fix-bar .bili-fix-text { white-space: nowrap !important; }
      #bili-fix-bar .bili-fix-gear {
        opacity: .55 !important; font-size: 13px !important; margin-left: 2px !important;
      }
      #bili-fix-bar:hover .bili-fix-gear { opacity: 1 !important; }

      #bili-fix-panel {
        position: fixed !important;
        right: 16px !important;
        bottom: 124px !important;
        z-index: 2147483646 !important;
        width: 304px !important;
        box-sizing: border-box !important;
        padding: 16px !important;
        border-radius: 12px !important;
        background: #18191c !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45) !important;
        color: #e3e5e7 !important;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif !important;
      }
      #bili-fix-panel * { box-sizing: border-box !important; }
      #bili-fix-panel .bili-fix-panel-title {
        display: flex !important; align-items: center !important; justify-content: space-between !important;
        margin-bottom: 12px !important; font-size: 14px !important; font-weight: 600 !important;
      }
      #bili-fix-panel .bili-fix-panel-sub {
        margin: -6px 0 12px !important; color: #9499a0 !important; font-size: 11px !important;
      }
      #bili-fix-panel .bili-fix-row {
        display: flex !important; align-items: center !important; justify-content: space-between !important;
        gap: 12px !important; margin: 9px 0 !important;
      }
      #bili-fix-panel .bili-fix-row label { flex: 1 !important; color: #c9ccd0 !important; }
      #bili-fix-panel input[type="number"] {
        width: 74px !important; padding: 4px 6px !important;
        border-radius: 5px !important; border: 1px solid #3d3f42 !important;
        background: #232528 !important; color: #e3e5e7 !important;
        font: inherit !important; text-align: right !important;
      }
      #bili-fix-panel input[type="checkbox"] {
        width: 15px !important; height: 15px !important; accent-color: #fb7299 !important;
      }
      #bili-fix-panel .bili-fix-actions {
        display: flex !important; gap: 8px !important; margin-top: 14px !important;
      }
      #bili-fix-panel .bili-fix-actions button { flex: 1 !important; }
      #bili-fix-panel .bili-fix-stats {
        margin: 10px 0 12px !important;
        padding: 10px 12px !important;
        border-radius: 8px !important;
        background: #202124 !important;
        border: 1px solid rgba(255,255,255,.05) !important;
      }
      #bili-fix-panel .bili-fix-stats-title {
        margin-bottom: 6px !important;
        color: #9499a0 !important;
        font-size: 11px !important;
        letter-spacing: .04em !important;
      }
      #bili-fix-panel .bili-fix-stat-row {
        display: flex !important;
        justify-content: space-between !important;
        gap: 12px !important;
        margin: 4px 0 !important;
        color: #c9ccd0 !important;
        font-size: 12px !important;
      }
      #bili-fix-panel .bili-fix-stat-row strong {
        color: #fb7299 !important;
        font-weight: 600 !important;
      }
      #bili-fix-panel .bili-fix-reset-stats {
        margin-top: 8px !important;
        width: 100% !important;
      }
      #bili-fix-panel .bili-fix-hint {
        margin-top: 10px !important; padding-top: 10px !important;
        border-top: 1px solid rgba(255,255,255,.06) !important;
        color: #9499a0 !important; font-size: 11px !important;
      }

      .bili-fix-btn {
        appearance: none !important;
        border: 1px solid rgba(255,255,255,.08) !important;
        border-radius: 6px !important;
        background: #2f3134 !important;
        color: #e3e5e7 !important;
        padding: 7px 14px !important;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif !important;
        cursor: pointer !important;
        transition: filter .15s ease !important;
      }
      .bili-fix-btn:hover { filter: brightness(1.15) !important; }
      .bili-fix-btn-primary {
        background: #fb7299 !important;
        border-color: #fb7299 !important;
        color: #fff !important;
      }
      .bili-fix-btn-small { padding: 3px 8px !important; font-size: 12px !important; }

      .bili-fix-overlay {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        background: rgba(0, 0, 0, 0.55) !important;
        backdrop-filter: blur(2px) !important;
      }
      .bili-fix-dialog {
        width: min(430px, calc(100vw - 40px)) !important;
        padding: 20px !important;
        border-radius: 12px !important;
        background: #18191c !important;
        border: 1px solid rgba(255,255,255,.08) !important;
        box-shadow: 0 20px 60px rgba(0,0,0,.55) !important;
        color: #e3e5e7 !important;
        font: 13px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif !important;
      }
      .bili-fix-dialog-title {
        margin-bottom: 10px !important;
        font-size: 16px !important;
        font-weight: 600 !important;
        color: #fff !important;
      }
      .bili-fix-dialog-message {
        white-space: pre-wrap !important;
        color: #c9ccd0 !important;
        margin-bottom: 18px !important;
      }
      .bili-fix-dialog-actions {
        display: flex !important;
        justify-content: flex-end !important;
        flex-wrap: wrap !important;
        gap: 8px !important;
      }
    `;
    (pageDocument.head || pageDocument.documentElement).appendChild(style);
  }

  function getFullscreenElement() {
    return pageDocument.fullscreenElement ||
      pageDocument.webkitFullscreenElement ||
      pageDocument.mozFullScreenElement ||
      pageDocument.msFullscreenElement ||
      null;
  }

  function isFullscreen() {
    if (getFullscreenElement()) return true;
    // B 站部分场景使用 CSS 全屏，不触发 Fullscreen API。
    const container = pageDocument.querySelector('.bpx-player-container, #bilibili-player');
    if (container && typeof container.className === 'string') {
      return /(?:^|\s)(?:bpx-player-container-fullscreen|bpx-player-fullscreen|bilibili-player-fullscreen)(?:\s|$)/.test(container.className);
    }
    return false;
  }

  function mountOverlay(el) {
    if (!el) return;
    const fullscreen = getFullscreenElement();
    // 原生 video 全屏时把 UI 挂进 video 内部不可见，继续放在 body 上；
    // B 站自定义全屏时 fullscreenElement 是播放器容器，挂进去才能显示。
    const parent = (fullscreen && fullscreen.tagName !== 'VIDEO')
      ? fullscreen
      : (pageDocument.body || pageDocument.documentElement);
    if (el.parentElement !== parent) parent.appendChild(el);
  }

  /* =========================================================================
   * 状态条与设置面板
   * ======================================================================= */

  function createStatusBar() {
    if (state.ui.bar) return;
    const bar = pageDocument.createElement('div');
    bar.id = 'bili-fix-bar';
    bar.title = '点击打开 Bili 断片守护设置（Alt+B）';
    bar.innerHTML = '<span class="bili-fix-dot"></span><span class="bili-fix-text">断片守护</span><span class="bili-fix-gear">⚙</span>';
    bar.addEventListener('click', toggleSettings);
    mountOverlay(bar);
    state.ui.bar = bar;
    updateBarVisibility();
  }

  function setBarVisible(visible) {
    if (!state.ui.bar) return;
    // CSS 中 display:flex 带 !important，普通 style.display 会被它覆盖，
    // 所以这里必须用 setProperty(..., 'important')。
    state.ui.bar.style.setProperty('display', visible ? 'flex' : 'none', 'important');
  }

  function updateBarVisibility() {
    setBarVisible(!!config.showStatus && !state.fullscreenHidden);
  }

  function createSettingsPanel() {
    if (state.ui.panel) return;
    const panel = pageDocument.createElement('div');
    panel.id = 'bili-fix-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="bili-fix-panel-title">
        <span>Bili 断片守护</span>
        <button class="bili-fix-btn bili-fix-btn-small" data-action="close">关闭</button>
      </div>
      <div class="bili-fix-panel-sub">播放器尝试跳过未加载片段时，暂停并等待。</div>
      <div class="bili-fix-stats">
        <div class="bili-fix-stats-title">运行统计</div>
        <div class="bili-fix-stat-row"><span>触发重试</span><strong id="bili-fix-stat-retries">0</strong></div>
        <div class="bili-fix-stat-row"><span>暂停等待</span><strong id="bili-fix-stat-waits">0</strong></div>
        <div class="bili-fix-stat-row"><span>拦截跳段</span><strong id="bili-fix-stat-blocked">0</strong></div>
        <button class="bili-fix-btn bili-fix-btn-small bili-fix-reset-stats" data-action="reset-stats">重置计数</button>
      </div>
      <div class="bili-fix-row"><label for="bili-fix-max-retries">最大重试次数</label><input id="bili-fix-max-retries" type="number" min="1" max="100" step="1"></div>
      <div class="bili-fix-row"><label for="bili-fix-retry-interval">重试间隔（毫秒）</label><input id="bili-fix-retry-interval" type="number" min="200" max="10000" step="100"></div>
      <div class="bili-fix-row"><label for="bili-fix-wait-timeout">等待超时（秒）</label><input id="bili-fix-wait-timeout" type="number" min="5" max="120" step="1"></div>
      <div class="bili-fix-row"><label for="bili-fix-disable-jump">关闭播放器预判跳段</label><input id="bili-fix-disable-jump" type="checkbox"></div>
      <div class="bili-fix-row"><label for="bili-fix-auto-pause">检测到跳段时自动暂停</label><input id="bili-fix-auto-pause" type="checkbox"></div>
      <div class="bili-fix-row"><label for="bili-fix-show-status">显示右下角状态条</label><input id="bili-fix-show-status" type="checkbox"></div>
      <div class="bili-fix-row"><label for="bili-fix-debug">调试日志</label><input id="bili-fix-debug" type="checkbox"></div>
      <div class="bili-fix-actions">
        <button class="bili-fix-btn bili-fix-btn-primary" data-action="save">保存</button>
        <button class="bili-fix-btn" data-action="defaults">恢复默认</button>
      </div>
      <div class="bili-fix-hint">修改重试次数后，对之后发起的片段请求生效；当前失败片段会自动重新请求。</div>
    `;
    panel.addEventListener('click', (event) => {
      const action = event.target && event.target.getAttribute && event.target.getAttribute('data-action');
      if (action === 'close') closeSettings();
      else if (action === 'save') saveSettingsFromPanel();
      else if (action === 'defaults') resetSettingsToDefaults();
      else if (action === 'reset-stats') resetStats();
    });
    mountOverlay(panel);
    state.ui.panel = panel;
    syncPanelFromConfig();
    updateStatsUI();
  }

  function syncPanelFromConfig() {
    if (!state.ui.panel) return;
    const $ = (id) => state.ui.panel.querySelector('#' + id);
    const maxRetries = $('bili-fix-max-retries');
    const retryInterval = $('bili-fix-retry-interval');
    const waitTimeout = $('bili-fix-wait-timeout');
    const disableJump = $('bili-fix-disable-jump');
    const autoPause = $('bili-fix-auto-pause');
    const showStatus = $('bili-fix-show-status');
    const debug = $('bili-fix-debug');
    if (maxRetries) maxRetries.value = config.maxRetries;
    if (retryInterval) retryInterval.value = config.retryInterval;
    if (waitTimeout) waitTimeout.value = config.waitTimeout;
    if (disableJump) disableJump.checked = !!config.disableJumpGaps;
    if (autoPause) autoPause.checked = !!config.autoPauseOnGap;
    if (showStatus) showStatus.checked = !!config.showStatus;
    if (debug) debug.checked = !!config.debug;
  }

  function saveSettingsFromPanel() {
    if (!state.ui.panel) return;
    const $ = (id) => state.ui.panel.querySelector('#' + id);
    const maxRetries = $('bili-fix-max-retries');
    const retryInterval = $('bili-fix-retry-interval');
    const waitTimeout = $('bili-fix-wait-timeout');
    config.maxRetries = clamp(parseInt(maxRetries && maxRetries.value, 10) || DEFAULTS.maxRetries, 1, 100);
    config.retryInterval = clamp(parseInt(retryInterval && retryInterval.value, 10) || DEFAULTS.retryInterval, 200, 10000);
    config.waitTimeout = clamp(parseInt(waitTimeout && waitTimeout.value, 10) || DEFAULTS.waitTimeout, 5, 120);
    config.disableJumpGaps = !!($('bili-fix-disable-jump') && $('bili-fix-disable-jump').checked);
    config.autoPauseOnGap = !!($('bili-fix-auto-pause') && $('bili-fix-auto-pause').checked);
    config.showStatus = !!($('bili-fix-show-status') && $('bili-fix-show-status').checked);
    config.debug = !!($('bili-fix-debug') && $('bili-fix-debug').checked);
    saveConfig();
    applyCoreSettings();
    updateBarVisibility();
    syncPanelFromConfig();
    closeSettings();
    showStatus('设置已保存', 'ok', 3000);
    log('设置已保存', config);
  }

  function resetSettingsToDefaults() {
    Object.assign(config, DEFAULTS);
    saveConfig();
    applyCoreSettings();
    updateBarVisibility();
    syncPanelFromConfig();
    showStatus('已恢复默认设置', 'ok', 3000);
  }

  function toggleSettings() {
    if (!state.ui.panel) return;
    if (state.ui.panel.style.display === 'none') openSettings();
    else closeSettings();
  }

  function openSettings() {
    if (!state.ui.panel) return;
    syncPanelFromConfig();
    updateStatsUI();
    state.ui.panel.style.display = 'block';
    mountOverlay(state.ui.panel);
  }

  function closeSettings() {
    if (state.ui.panel) state.ui.panel.style.display = 'none';
  }

  function showStatus(text, kind, duration) {
    state.lastStatus = text;
    if (state.ui.bar) {
      const textEl = state.ui.bar.querySelector('.bili-fix-text');
      const dot = state.ui.bar.querySelector('.bili-fix-dot');
      if (textEl) textEl.textContent = text;
      if (dot) {
        dot.style.background = kind === 'warn' ? '#f0a020'
          : kind === 'error' ? '#e74c3c'
          : kind === 'info' ? '#3498db'
          : '#2ecc71';
      }
    }
    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
      state.statusTimer = null;
    }
    if (duration && duration > 0) {
      state.statusTimer = setTimeout(() => {
        state.statusTimer = null;
        if (state.ui.bar && !state.pendingGap) {
          const textEl = state.ui.bar.querySelector('.bili-fix-text');
          const dot = state.ui.bar.querySelector('.bili-fix-dot');
          if (textEl) textEl.textContent = defaultStatusText();
          if (dot) dot.style.background = '#2ecc71';
        }
      }, duration);
    }
  }

  /* =========================================================================
   * dash.js 接管
   * ======================================================================= */

  function hookDashjs() {
    let current = null;

    function install(dashjs) {
      if (!dashjs || dashjs.__biliFixPatched) return dashjs;
      try {
        const OriginalMediaPlayer = dashjs.MediaPlayer;
        if (typeof OriginalMediaPlayer !== 'function') return dashjs;

        const WrappedMediaPlayer = function () {
          const factory = OriginalMediaPlayer.apply(this, arguments);
          try {
            if (factory && typeof factory.create === 'function' && !factory.__biliFixCreate) {
              const originalCreate = factory.create;
              factory.create = function () {
                const core = originalCreate.apply(this, arguments);
                try {
                  setupCore(core);
                } catch (err) {
                  warn('接管 dash.js 实例失败', err);
                }
                return core;
              };
              factory.__biliFixCreate = true;
            }
          } catch (err) {
            warn('包装 MediaPlayer().create 失败', err);
          }
          return factory;
        };

        // 保留 MediaPlayer 上的静态属性（Version、FactoryMaker 等）
        for (const key of Object.getOwnPropertyNames(OriginalMediaPlayer)) {
          if (key === 'length' || key === 'name' || key === 'prototype' || key === 'arguments' || key === 'caller') continue;
          try {
            WrappedMediaPlayer[key] = OriginalMediaPlayer[key];
          } catch (err) {
            /* 忽略只读属性 */
          }
        }

        dashjs.MediaPlayer = WrappedMediaPlayer;
        dashjs.__biliFixPatched = true;
        log('已接管 pageWindow.dashjs.MediaPlayer');
      } catch (err) {
        warn('接管 pageWindow.dashjs 失败', err);
      }
      return dashjs;
    }

    try {
      current = pageWindow.dashjs;
      Object.defineProperty(pageWindow, 'dashjs', {
        configurable: true,
        enumerable: true,
        get() {
          return current;
        },
        set(value) {
          current = install(value);
        },
      });
    } catch (err) {
      warn('无法拦截 pageWindow.dashjs 赋值，改用轮询', err);
    }

    if (current) install(current);

    // 某些情况下页面会用 Object.defineProperty 重新定义 pageWindow.dashjs，
    // 或者脚本注入较晚，这里用低频轮询兜底。
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      try {
        if (pageWindow.dashjs && !pageWindow.dashjs.__biliFixPatched) install(pageWindow.dashjs);
      } catch (err) {
        /* ignore */
      }
      if (tries >= 300) clearInterval(timer); // 5 分钟
    }, 1000);
  }

  function setupCore(core) {
    if (!core || core.__biliFixSetup) return;
    core.__biliFixSetup = true;
    state.core = core;

    // 1. 强制关闭 jumpGaps：B 站在初始化时会调用 setJumpGaps(true)，
    //    所以不仅设置初始值，还要包装 setter，防止之后被改回去。
    if (typeof core.setJumpGaps === 'function') {
      try {
        const originalSetJumpGaps = core.setJumpGaps;
        core.setJumpGaps = function (value) {
          return originalSetJumpGaps.call(this, config.disableJumpGaps ? false : value);
        };
        core.setJumpGaps(!config.disableJumpGaps);
      } catch (err) {
        warn('包装 setJumpGaps 失败', err);
      }
    }

    // 2. 强制最小重试次数。B 站可能传入 3，这里统一抬到用户配置值。
    if (typeof core.setFragmentLoaderRetryAttempts === 'function') {
      try {
        const originalSetRetryAttempts = core.setFragmentLoaderRetryAttempts;
        core.setFragmentLoaderRetryAttempts = function (value) {
          const wanted = Math.max(parseInt(value, 10) || 0, config.maxRetries);
          return originalSetRetryAttempts.call(this, wanted);
        };
        core.setFragmentLoaderRetryAttempts(config.maxRetries);
      } catch (err) {
        warn('包装 setFragmentLoaderRetryAttempts 失败', err);
      }
    }

    // 3. 固定重试间隔。
    if (typeof core.setFragmentLoaderRetryInterval === 'function') {
      try {
        const originalSetRetryInterval = core.setFragmentLoaderRetryInterval;
        core.setFragmentLoaderRetryInterval = function () {
          return originalSetRetryInterval.call(this, config.retryInterval);
        };
        core.setFragmentLoaderRetryInterval(config.retryInterval);
      } catch (err) {
        warn('包装 setFragmentLoaderRetryInterval 失败', err);
      }
    }

    // 4. 监听重试与跳段事件。
    const on = (name, handler) => {
      try {
        if (typeof core.on === 'function') core.on(name, handler);
      } catch (err) {
        warn('监听事件失败：' + name, err);
      }
    };
    on('requestRetryed', onRequestRetryed);
    on('predictSeek', onPredictSeek);
    on('jumpMediaGap', onJumpMediaGap);
    on('bufferStalled', onBufferStalled);
    on('bufferLoaded', onBufferLoaded);
    on('playbackSeeking', onPlaybackSeeking);
    on('playbackSeeked', onPlaybackSeeked);

    log('已接管 dash.js 核心实例', {
      jumpGaps: typeof core.getJumpGaps === 'function' ? core.getJumpGaps() : 'unknown',
    });
    showStatus('断片守护已启用', 'ok', 3000);
  }

  function applyCoreSettings() {
    const core = state.core;
    if (!core) return;
    try {
      if (typeof core.setFragmentLoaderRetryAttempts === 'function') {
        core.setFragmentLoaderRetryAttempts(config.maxRetries);
      }
      if (typeof core.setFragmentLoaderRetryInterval === 'function') {
        core.setFragmentLoaderRetryInterval(config.retryInterval);
      }
      if (typeof core.setJumpGaps === 'function') {
        core.setJumpGaps(!config.disableJumpGaps);
      }
    } catch (err) {
      warn('应用播放器设置失败', err);
    }
  }

  /* =========================================================================
   * 核心事件处理
   * ======================================================================= */

  function makeRetryKey(event) {
    return [event && event.url, event && event.range, event && event.mediaType].join('|');
  }

  function onRequestRetryed(event) {
    const times = Number(event && event.retryTimes) || 0;
    const key = makeRetryKey(event);
    log('requestRetryed', times, event);

    if (times > 0) {
      bumpStat('retries');
      if (!state.pendingGap) {
        showStatus('片段加载失败，正在重试 ' + times + '/' + config.maxRetries, 'warn', 3500);
      }
    }

    if (times >= config.maxRetries && !state.retryDialogKeys.has(key)) {
      state.retryDialogKeys.add(key);
      showRetryDialog(event, times, key);
    }
  }

  function onPredictSeek(event) {
    if (!config.autoPauseOnGap) return;
    const video = getVideo();
    if (!video) return;
    const from = Number(event && event.currentTime);
    const to = Number(event && (event.destination != null ? event.destination : event.seekToPosition));
    log('predictSeek', event);
    pauseForGap(video, '播放器准备跳过未加载片段，已暂停等待', isFiniteNumber(to) ? to : (isFiniteNumber(from) ? from + 1 : null));
  }

  function onJumpMediaGap(event) {
    if (!config.autoPauseOnGap) return;
    if (event && event.toEnd) return; // 跳到流结尾不拦
    const video = getVideo();
    if (!video) return;
    const from = Number(event && event.time);
    const to = Number(event && event.seekToPosition);
    log('jumpMediaGap', event);
    pauseForGap(video, '播放器跳过了未加载片段，已暂停等待', isFiniteNumber(to) ? to : null);
  }

  function onBufferStalled(event) {
    if (state.pendingGap) return;
    log('bufferStalled', event);
    showStatus('缓冲中，等待片段加载…', 'info', 3000);
  }

  function onBufferLoaded(event) {
    if (state.pendingGap) return;
    log('bufferLoaded', event);
  }

  function onPlaybackSeeking(event) {
    log('playbackSeeking', event);
  }

  function onPlaybackSeeked(event) {
    log('playbackSeeked', event);
  }

  /* =========================================================================
   * currentTime 兜底拦截
   * ======================================================================= */

  function hookCurrentTime() {
    const proto = pageWindow.HTMLMediaElement.prototype;
    if (!proto || proto.__biliFixTimeHooked) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'currentTime');
    if (!descriptor || typeof descriptor.set !== 'function') return;

    try {
      Object.defineProperty(proto, 'currentTime', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value) {
          if (this instanceof pageWindow.HTMLVideoElement) {
            if (state.allowSeekOnce) {
              state.allowSeekOnce = false;
              return descriptor.set.call(this, value);
            }
            if (shouldBlockGapSeek(this, value)) {
              handleGapSeek(this, value);
              return;
            }
          }
          return descriptor.set.call(this, value);
        },
      });
      proto.__biliFixTimeHooked = true;
    } catch (err) {
      warn('hook HTMLMediaElement.currentTime 失败', err);
      return;
    }

    if (typeof proto.fastSeek === 'function') {
      const originalFastSeek = proto.fastSeek;
      proto.fastSeek = function (time) {
        if (this instanceof pageWindow.HTMLVideoElement && shouldBlockGapSeek(this, time)) {
          handleGapSeek(this, time);
          return;
        }
        return originalFastSeek.call(this, time);
      };
    }
  }

  function shouldBlockGapSeek(video, target) {
    if (!config.autoPauseOnGap) return false;
    if (!state.video || video !== state.video) return false;
    if (!isFiniteNumber(target)) return false;
    if (video.ended || video.readyState < 2) return false;
    if (Date.now() < state.userSeekUntil) return false;

    // 已经因为 gap 暂停过：拦下播放器随后补发的 seek。
    if (state.pendingGap) {
      const to = state.pendingGap.to;
      if (isFiniteNumber(to) && Math.abs(target - to) < 1.0) return true;
      if (target > video.currentTime + 1.0) return true;
      return false;
    }

    if (video.paused) return false;

    const current = video.currentTime;
    if (!(target > current + 1.2)) return false;

    // 当前缓冲还有较多余量时，可能是正常 seek 或切换，不拦。
    const end = getBufferedEnd(video, current);
    if (end - current > 1.5) return false;

    // 目标仍在当前缓冲区内，不需要拦。
    if (target <= end + 0.1) return false;

    return true;
  }

  function handleGapSeek(video, target) {
    bumpStat('blocked');
    log('拦截跳段', video.currentTime, '->', target);
    pauseForGap(video, '已拦截播放器跳过未加载片段，暂停等待加载', target);
  }

  function pauseForGap(video, reason, target) {
    if (!video) return;
    const now = Date.now();
    if (state.pendingGap && now - state.pendingGap.at < 1500) {
      // 短时间内重复触发，只补充目标位置
      if (isFiniteNumber(target) && !isFiniteNumber(state.pendingGap.to)) {
        state.pendingGap.to = target;
      }
      return;
    }

    state.pendingGap = {
      from: video.currentTime,
      to: isFiniteNumber(target) ? target : null,
      at: now,
      reason: reason || '检测到未加载片段',
    };
    state.wasPlaying = !video.paused;
    bumpStat('waits');

    try {
      video.pause();
    } catch (err) {
      /* ignore */
    }

    showStatus(reason || '检测到未加载片段，已暂停等待', 'warn', 5000);
    nudgeReload(video);
    startWatchdog(video);
  }

  function nudgeReload(video) {
    const now = Date.now();
    if (now - state.lastNudgeAt < 1200) return;
    state.lastNudgeAt = now;
    if (state.nudgeTimer) clearTimeout(state.nudgeTimer);
    state.nudgeTimer = setTimeout(() => {
      state.nudgeTimer = null;
      if (!state.pendingGap || !video || !video.isConnected) return;
      const target = Math.max(0, video.currentTime - 0.15);
      try {
        if (state.core && typeof state.core.seek === 'function') {
          state.core.seek(target);
        } else if (state.player && typeof state.player.seek === 'function') {
          state.player.seek(target);
        } else {
          state.allowSeekOnce = true;
          video.currentTime = target;
        }
        log('已重新触发当前片段加载', target);
      } catch (err) {
        warn('重新触发加载失败', err);
      }
    }, 300);
  }

  function retryCurrentFragment() {
    const video = getVideo();
    if (!video) return;
    const target = video.currentTime;
    try {
      if (state.core && typeof state.core.seek === 'function') {
        state.core.seek(target);
      } else if (state.player && typeof state.player.seek === 'function') {
        state.player.seek(target);
      } else {
        state.allowSeekOnce = true;
        video.currentTime = target;
      }
    } catch (err) {
      warn('重新请求当前片段失败', err);
    }
  }

  function startWatchdog(video) {
    stopWatchdog();
    const startedAt = Date.now();
    state.watchdog = setInterval(() => {
      if (!state.pendingGap) {
        stopWatchdog();
        return;
      }
      const currentVideo = state.video || video;
      if (!currentVideo) {
        stopWatchdog();
        return;
      }
      const from = state.pendingGap.from;
      // gap 被补上：当前时间后 0.4 秒已经进入缓冲。
      if (isBuffered(currentVideo, from + 0.4, 0.5)) {
        stopWatchdog();
        state.pendingGap = null;
        showStatus('片段已加载，继续播放', 'ok', 3000);
        if (state.wasPlaying) {
          currentVideo.play().catch(() => {});
        }
        return;
      }
      if (Date.now() - startedAt > config.waitTimeout * 1000) {
        stopWatchdog();
        showWaitTimeoutDialog(currentVideo);
      }
    }, 500);
  }

  function stopWatchdog() {
    if (state.watchdog) {
      clearInterval(state.watchdog);
      state.watchdog = null;
    }
  }

  function resetGapState() {
    stopWatchdog();
    state.pendingGap = null;
    state.wasPlaying = false;
    state.allowSeekOnce = false;
  }

  function skipGap(video) {
    if (!video) return;
    const current = video.currentTime;
    const end = getBufferedEnd(video, current);
    const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : current + 10;
    let target = getNextBufferedStart(video, end);
    if (target == null) target = Math.min(duration, current + 10);
    target = Math.max(0, Math.min(target + 0.05, duration - 0.1));
    state.pendingGap = null;
    state.allowSeekOnce = true;
    stopWatchdog();
    try {
      video.currentTime = target;
    } catch (err) {
      state.allowSeekOnce = false;
      warn('跳过片段失败', err);
    }
    setTimeout(() => {
      state.allowSeekOnce = false;
    }, 1000);
    video.play().catch(() => {});
    showStatus('已跳过缺失片段（' + fmtTime(current) + ' → ' + fmtTime(target) + '）', 'warn', 5000);
  }

  function checkUpcomingGap(video) {
    if (!config.autoPauseOnGap || !video || video.paused || video.ended) return;
    if (state.pendingGap) return;
    if (Date.now() < state.userSeekUntil) return;
    const now = Date.now();
    if (now - state.lastGapCheck < 300) return;
    state.lastGapCheck = now;
    if (video.readyState < 2 || !video.buffered || video.buffered.length === 0) return;

    const current = video.currentTime;
    const end = getBufferedEnd(video, current);
    if (end - current > 0.8) return;
    const next = getNextBufferedStart(video, end);
    if (next == null || next - end < 0.3) return;

    log('检测到前方缓冲空洞', { current, end, next });
    pauseForGap(video, '前方片段缺失，已暂停等待加载', next);
  }

  /* =========================================================================
   * 弹窗
   * ======================================================================= */

  function enqueueDialog(options) {
    return new Promise((resolve) => {
      state.dialogQueue.push({ options, resolve });
      processDialogQueue();
    });
  }

  function processDialogQueue() {
    if (state.dialogActive) return;
    const item = state.dialogQueue.shift();
    if (!item) return;
    state.dialogActive = true;
    renderDialog(item.options, (value) => {
      state.dialogActive = false;
      item.resolve(value);
      processDialogQueue();
    });
  }

  function renderDialog(options, done) {
    const overlay = pageDocument.createElement('div');
    overlay.className = 'bili-fix-overlay';

    const card = pageDocument.createElement('div');
    card.className = 'bili-fix-dialog';

    const title = pageDocument.createElement('div');
    title.className = 'bili-fix-dialog-title';
    title.textContent = options.title || '提示';

    const message = pageDocument.createElement('div');
    message.className = 'bili-fix-dialog-message';
    message.textContent = options.message || '';

    const actions = pageDocument.createElement('div');
    actions.className = 'bili-fix-dialog-actions';

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      pageDocument.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (state.ui.dialog === overlay) state.ui.dialog = null;
      done(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('cancel');
      }
    };
    pageDocument.addEventListener('keydown', onKey, true);

    const buttons = options.buttons || [{ text: '知道了', value: 'ok', primary: true }];
    for (const item of buttons) {
      const button = pageDocument.createElement('button');
      button.className = 'bili-fix-btn' + (item.primary ? ' bili-fix-btn-primary' : '');
      button.textContent = item.text;
      button.addEventListener('click', () => finish(item.value));
      actions.appendChild(button);
    }

    card.appendChild(title);
    card.appendChild(message);
    card.appendChild(actions);
    overlay.appendChild(card);
    state.ui.dialog = overlay;
    mountOverlay(overlay);
    const first = actions.querySelector('button');
    if (first) setTimeout(() => first.focus(), 0);
  }

  function showRetryDialog(event, times, key) {
    const mediaType = event && event.mediaType === 'audio' ? '音频' : '视频';
    const range = event && event.range ? '\n字节范围：' + event.range : '';
    enqueueDialog({
      title: '片段加载持续失败',
      message: mediaType + '片段已连续重试 ' + times + ' 次仍未成功。' + range +
        '\n\n继续重试会提高重试上限，并重新请求当前片段；跳过则会放弃缺失片段，声音和画面可能出现不连续。',
      buttons: [
        { text: '继续重试', value: 'retry', primary: true },
        { text: '跳过这一段', value: 'skip' },
        { text: '暂停等待', value: 'pause' },
      ],
    }).then((choice) => {
      state.retryDialogKeys.delete(key);
      if (choice === 'retry') {
        config.maxRetries = clamp(config.maxRetries + 10, 1, 100);
        saveConfig();
        syncPanelFromConfig();
        applyCoreSettings();
        retryCurrentFragment();
        showStatus('重试上限已提高到 ' + config.maxRetries + ' 次', 'ok', 4000);
      } else if (choice === 'skip') {
        skipGap(getVideo());
      } else {
        pauseForGap(getVideo(), '已暂停，等待片段加载', null);
      }
    });
  }

  function showWaitTimeoutDialog(video) {
    enqueueDialog({
      title: '片段加载超时',
      message: '已等待 ' + config.waitTimeout + ' 秒，缺失片段仍未加载成功。\n你可以继续等待，或跳过这一段。',
      buttons: [
        { text: '继续等待', value: 'wait', primary: true },
        { text: '跳过这一段', value: 'skip' },
        { text: '刷新页面', value: 'reload' },
      ],
    }).then((choice) => {
      if (choice === 'wait') {
        nudgeReload(video);
        startWatchdog(video);
        showStatus('继续等待片段加载…', 'warn', 3000);
      } else if (choice === 'skip') {
        skipGap(video);
      } else if (choice === 'reload') {
        pageWindow.location.reload();
      } else {
        // Esc 或取消：保持暂停，允许用户稍后手动继续。
        showStatus('已暂停等待片段加载', 'warn', 0);
      }
    });
  }

  /* =========================================================================
   * video 事件
   * ======================================================================= */

  function bindVideo(video) {
    if (!video) return;
    state.video = video;
    if (video.__biliFixBound) return;
    video.__biliFixBound = true;

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('play', onPlay);
    video.addEventListener('progress', onProgress);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('emptied', resetGapState);
    video.addEventListener('loadstart', onLoadStart);
    video.addEventListener('error', onVideoError);

    log('video 已绑定');
  }

  function onTimeUpdate() {
    const video = state.video;
    if (!video) return;
    if (state.pendingGap) {
      if (isBuffered(video, state.pendingGap.from + 0.4, 0.5)) {
        stopWatchdog();
        state.pendingGap = null;
        showStatus('片段已加载，继续播放', 'ok', 3000);
        if (state.wasPlaying) video.play().catch(() => {});
      }
      return;
    }
    checkUpcomingGap(video);
  }

  function onWaiting() {
    if (state.pendingGap) return;
    showStatus('缓冲中，等待片段加载…', 'info', 0);
  }

  function onPlaying() {
    if (state.pendingGap) return;
    showStatus(defaultStatusText(), 'ok', 0);
  }

  function onPlay() {
    const video = state.video;
    if (!video) return;
    if (state.pendingGap) {
      // 尊重用户手动点击播放的意图，允许继续播放；如果播放器再次尝试
      // 跳过缺失片段，currentTime setter 会继续拦截。
      showStatus('继续播放，等待缺失片段…', 'warn', 3000);
      return;
    }
    // 刚恢复播放时 buffered 可能还没更新，延迟检查当前时间是否真的有数据。
    setTimeout(() => {
      if (!video.isConnected || video.paused || state.pendingGap) return;
      // 用户主动 seek 到未缓冲位置时，浏览器本来就会等待，不要重复打断。
      if (Date.now() < state.userSeekUntil) return;
      if (video.readyState >= 2 && video.buffered.length > 0 &&
          !isBuffered(video, video.currentTime + 0.2, 0.5)) {
        pauseForGap(video, '当前片段未加载，已暂停等待', null);
      }
    }, 350);
  }

  function onProgress() {
    const video = state.video;
    if (!video || !state.pendingGap) return;
    if (isBuffered(video, state.pendingGap.from + 0.4, 0.5)) {
      stopWatchdog();
      state.pendingGap = null;
      showStatus('片段已加载，继续播放', 'ok', 3000);
      if (state.wasPlaying) video.play().catch(() => {});
    }
  }

  function onSeeked() {
    const video = state.video;
    if (!video || !state.pendingGap) return;

    // 用户主动 seek 到了别的位置：放弃旧的 gap 等待，避免继续弹超时窗。
    if (Date.now() < state.userSeekUntil &&
        Math.abs(video.currentTime - state.pendingGap.from) > 1) {
      log('用户 seek 到其他位置，取消 gap 等待');
      resetGapState();
      return;
    }

    if (isBuffered(video, state.pendingGap.from + 0.4, 0.5)) {
      stopWatchdog();
      state.pendingGap = null;
      showStatus('片段已加载，继续播放', 'ok', 3000);
      if (state.wasPlaying) video.play().catch(() => {});
    }
  }

  function onLoadStart() {
    resetGapState();
  }

  function onVideoError() {
    const video = state.video;
    const error = video && video.error;
    if (!error) return;
    showStatus('视频错误（代码 ' + error.code + '）', 'error', 6000);
    warn('video error', error.code, error.message);
  }

  /* =========================================================================
   * 用户主动 seek 判定
   * ======================================================================= */

  function markUserSeek() {
    state.userSeekUntil = Date.now() + 2000;
  }

  function bindGlobalEvents() {
    const seekSelector = [
      '.bpx-player-progress',
      '.bpx-player-control-bottom',
      '.bpx-player-control-wrap',
      '.bilibili-player-video-progress',
      '.bilibili-player-video-control',
    ].join(',');

    const onPointerDown = (event) => {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest(seekSelector)) {
        markUserSeek();
      }
    };
    pageWindow.addEventListener('pointerdown', onPointerDown, true);
    pageWindow.addEventListener('mousedown', onPointerDown, true);
    pageWindow.addEventListener('touchstart', onPointerDown, true);

    pageWindow.addEventListener('keydown', (event) => {
      if (event.altKey && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault();
        event.stopPropagation();
        toggleSettings();
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].indexOf(event.key) >= 0) {
        markUserSeek();
      }
    }, true);

    pageDocument.addEventListener('fullscreenchange', onFullscreenChange);
    pageDocument.addEventListener('webkitfullscreenchange', onFullscreenChange);
    // B 站部分 CSS 全屏场景不触发 fullscreenchange，用 resize 兜底。
    pageWindow.addEventListener('resize', onFullscreenChange);
    pageWindow.addEventListener('pagehide', cleanup, { once: true });
  }

  function onFullscreenChange() {
    const fullscreen = isFullscreen();
    if (state.lastFullscreenState === fullscreen) {
      if (state.ui.dialog) mountOverlay(state.ui.dialog);
      return;
    }
    state.lastFullscreenState = fullscreen;
    state.fullscreenHidden = fullscreen;
    updateBarVisibility();
    if (fullscreen) closeSettings();
    if (state.ui.bar) mountOverlay(state.ui.bar);
    if (state.ui.panel) mountOverlay(state.ui.panel);
    if (state.ui.dialog) mountOverlay(state.ui.dialog);
  }

  function setPageUIEnabled(enabled) {
    config.showStatus = !!enabled;
    saveConfig();
    syncPanelFromConfig();
    updateBarVisibility();
    if (!enabled) {
      closeSettings();
    } else {
      showStatus(defaultStatusText(), 'ok', 0);
    }
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('显示 Bili 断片守护 UI', () => setPageUIEnabled(true));
      GM_registerMenuCommand('隐藏 Bili 断片守护 UI', () => setPageUIEnabled(false));
      GM_registerMenuCommand('重置断片统计', () => resetStats());
    } catch (err) {
      warn('注册油猴菜单失败', err);
    }
  }

  function cleanup() {
    stopWatchdog();
    if (state.nudgeTimer) {
      clearTimeout(state.nudgeTimer);
      state.nudgeTimer = null;
    }
  }

  /* =========================================================================
   * 初始化
   * ======================================================================= */

  function initUI() {
    injectStyles();
    createStatusBar();
    createSettingsPanel();
    bindGlobalEvents();
    onFullscreenChange();
    if (state.core) {
      showStatus('断片守护已启用', 'ok', 3000);
    } else {
      showStatus(defaultStatusText(), 'ok', 0);
    }
  }

  function init() {
    if (pageWindow.__biliLoaderFixInjected) return;
    pageWindow.__biliLoaderFixInjected = true;

    registerMenuCommands();
    state.player = getPlayer();
    hookDashjs();
    hookCurrentTime();

    if (pageDocument.readyState === 'loading') {
      pageDocument.addEventListener('DOMContentLoaded', initUI, { once: true });
    } else {
      initUI();
    }

    // 轮询 video：SPA 切分 P、切换清晰度时 video 元素可能被替换。
    const videoTimer = setInterval(() => {
      state.player = getPlayer();
      const video = pageDocument.querySelector('video');
      if (video && video !== state.video) bindVideo(video);
    }, 1000);

    pageWindow.addEventListener('pagehide', () => clearInterval(videoTimer), { once: true });

    // 方便高级用户在控制台调试。
    pageWindow.__biliFix = {
      config,
      state,
      getVideo,
      showStatus,
      showRetryDialog,
      showWaitTimeoutDialog,
      skipGap: () => skipGap(getVideo()),
      retryCurrentFragment,
      applyCoreSettings,
      saveConfig,
      openSettings,
      closeSettings,
      setPageUIEnabled,
      updateBarVisibility,
      registerMenuCommands,
      resetStats,
      bumpStat,
      updateStatsUI,
      defaultStatusText,
    };
  }

  init();
})();
