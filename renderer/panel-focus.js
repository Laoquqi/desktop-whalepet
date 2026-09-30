/* ===========================================================================
   面板打开时临时允许窗口被激活 —— 让面板里的输入框 / 下拉能正常用
   ---------------------------------------------------------------------------
   用户报（2026-09-30）：
     "小鲸鱼记账里的输入框和选择栏都无法正常使用。点击桌面菜单的功能后
      会出现点击桌宠无反应的情况，会卡死。"

   根因：桌宠窗口设了 `setFocusable(false)`（见 main.cjs —— 那是为了修
   "点桌宠抢焦点导致视频/直播暂停"）。Windows 上这会给窗口加
   WS_EX_NOACTIVATE，**窗口拿不到键盘焦点** ——
   于是面板里的 <input> 打不了字、<select> 拉不出来，
   有些面板还会因为拿不到焦点而进入奇怪状态（表现为"点了没反应"）。

   修法：**只在挂件面板打开期间**把窗口设回可激活，面板一关立刻恢复不可激活。
   这样两边都保住：
     · 平时点桌宠依然不抢焦点（视频不会暂停）
     · 面板打开时输入框 / 下拉能正常用

   ⚠️ 范围只含**挂件自带的面板**（和用户划定的范围一致）：
      不含 rice（偷吃白饭）/ 形象与互动 / 一级菜单 ☰ / 各种 mask 遮罩。
   =========================================================================== */
(function () {
  'use strict'

  var PANEL_SEL = [
    '.dshwv-linepanel',       // 全局设置
    '.dshwv-custmenu',        // 按压泡泡设置
    '.dshwv-fontmenu',        // 自定义字体
    '.dshwv-rgbmenu',         // 自定义颜色
    '.dshwv-qcolmenu',        // 自定义队列配色
    '.dshwv-usagepanel',      // 用量面板
    '.dshwv-audiowin',        // 音频导入
    '.dshwv-confirmwin',      // 确认框
    '.dshwv-cropwin',         // 图片裁剪
    '.dshwv-gifwin',          // GIF 编辑
    '.dshwv-snapwin',         // 吸附设置
  ].join(', ')

  var lastWant = null

  function log(msg) {
    try { if (window.petApi && window.petApi.log) window.petApi.log('[面板焦点] ' + msg) } catch (e) {}
  }

  function isShown(el) {
    if (!el || !el.isConnected) return false
    try {
      var cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      if (parseFloat(cs.opacity) === 0) return false
      var r = el.getBoundingClientRect()
      return r.width > 2 && r.height > 2
    } catch (e) { return false }
  }

  function scan() {
    var want = false
    try {
      var list = document.querySelectorAll(PANEL_SEL)
      for (var i = 0; i < list.length; i++) {
        if (isShown(list[i])) { want = true; break }
      }
    } catch (e) { return }
    if (want === lastWant) return          // 状态没变就不发 IPC（省开销、避免抖动）
    lastWant = want
    log(want ? '面板打开 → 允许窗口被激活（输入框可用）' : '面板关闭 → 恢复不可激活')
    try { if (window.petApi && window.petApi.panelFocus) window.petApi.panelFocus(want) } catch (e) {}
  }

  function start() {
    if (window.__dshpetPanelFocus) return
    window.__dshpetPanelFocus = true
    // 面板随时开合，轮询最稳；250ms 一次、只做一次 querySelectorAll。
    setInterval(scan, 250)
    scan()
    log('已就绪')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})();
