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
    '.dshwv-usagepanel',      // 用量面板（旧版类名，保留兼容）
    '.dshwv-usage-sub',       // ★ 用量/记账子界面（真实类名 —— 见下面的说明）
    '.dshwv-audiowin',        // 音频导入
    '.dshwv-confirmwin',      // 确认框
    '.dshwv-cropwin',         // 图片裁剪
    '.dshwv-gifwin',          // GIF 编辑
    '.dshwv-snapwin',         // 吸附设置
    // ★ 一级菜单**开着**的时候也算：小鲸鱼记账这类子界面整个挂在菜单里
    //   （.dshwv-menu > .dshwv-usage-area > .dshwv-usage-sub），
    //   菜单不同时"开着"根本进不去。见下面 hasVisibleForm 的说明。
    '.dshwv-menu.dshwv-menu-open',
  ].join(', ')

  // ⚠️⚠️ **为什么不能只靠上面那张类名清单（上一版就是这么挂的）：**
  //    用户报"小鲸鱼记账里的输入框和选择栏都无法正常使用"。
  //    查下来：清单里的 `.dshwv-usagepanel` **在 0.3.17 里根本不存在** ——
  //    全项目只有 CSS 和各处 `closest()` 提到它，没有任何地方给元素加过这个类。
  //    真正的记账界面是 `.dshwv-usage-sub`，而且**挂在 ☰ 菜单内部**
  //    （`.dshwv-menu > .dshwv-usage-area > .dshwv-usage-sub`）。
  //    于是清单一个都没命中 → `pet:panel-focus` 从来没发过 →
  //    窗口一直停在"不可激活"（WS_EX_NOACTIVATE）→
  //    `<input>` 打不了字、`<select>` 拉不出来。
  //
  //    所以这里加一条**不依赖类名清单**的兜底判据：
  //    只要页面上有"挂件自己的、真的看得见的表单控件"（input/select/textarea），
  //    就说明用户正在跟表单打交道 → 放开可激活。
  //    这样以后上游再加新面板、再改类名，输入框也照样能用。
  function belongsToWidget(el) {
    var n = el
    while (n && n !== document.body && n !== document.documentElement) {
      var c = (typeof n.className === 'string') ? n.className : ''
      if (c && c.indexOf('dshwv') >= 0) return true
      n = n.parentElement
    }
    return false
  }
  // 只认"需要键盘/需要系统弹层"的控件 —— 勾选框、单选、滑块、文件、颜色这些
  // 不靠窗口焦点也能用，把它们也算进来的话一开菜单就抢焦点了（没必要）。
  var FORM_OK = {
    text: 1, search: 1, number: 1, password: 1, email: 1, url: 1, tel: 1, '': 1,
  }
  function needsFocus(el) {
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (tag !== 'INPUT') return false
    var t = String(el.type || 'text').toLowerCase()
    return !!FORM_OK[t]
  }
  function hasVisibleForm() {
    var list
    try { list = document.querySelectorAll('input, select, textarea') } catch (e) { return false }
    for (var i = 0; i < list.length; i++) {
      var el = list[i]
      if (el.type === 'hidden' || el.disabled) continue
      if (!needsFocus(el)) continue
      if (!belongsToWidget(el)) continue
      if (isShown(el)) return true
    }
    return false
  }

  var lastWant = null

  function log(msg) {
    try { if (window.petApi && window.petApi.log) window.petApi.log('[面板焦点] ' + msg) } catch (e) {}
  }

  function isShown(el) {
    if (!el || !el.isConnected) return false
    try {
      // ⚠️⚠️ **可见性要沿着祖先一路看，不能只看自己。**
      //    鲸鱼菜单收起时是 `opacity:0`（**不是** display:none），
      //    而菜单里的行/控件自己的 computed opacity 是 1 ——
      //    只看自己的话，会把"收起的菜单里的输入框"当成可见的，
      //    于是**页面一加载就判定"有面板开着"→ 窗口一直被设成可激活**，
      //    "平时点她不抢焦点"就白做了（实测日志：加载那一刻就发了"可激活"）。
      //    drag-physics.js 里踩过同一个坑，那边注释写得很清楚。
      var n = el
      while (n && n !== document.body && n !== document.documentElement) {
        var cs = getComputedStyle(n)
        if (cs.display === 'none' || cs.visibility === 'hidden') return false
        if (parseFloat(cs.opacity) === 0) return false
        n = n.parentElement
      }
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
    if (!want) { try { want = hasVisibleForm() } catch (e) {} }
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
    // ⚠️ 光靠 250ms 轮询有个时序坑：用户"移过去就点"的话，
    //    点下去的那一刻窗口可能还是"不可激活"的 —— 那一下点击就不会聚焦输入框。
    //    所以在鼠标移动时也立刻扫一次（同样的 scan，状态没变不会重复发 IPC）。
    try { window.addEventListener('mousemove', scan, true) } catch (e) {}
    scan()
    log('已就绪')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})();
