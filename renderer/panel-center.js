/* ===========================================================================
   二级 / 三级菜单：显示在屏幕正中央 + 可拖动
   ---------------------------------------------------------------------------
   用户要求（2026-09-30）：
     "二级菜单（全局设置/按压泡泡设置/自定义菜单等等）和三级菜单要显示在
      屏幕正中央并且可以拖动，**不要改一级菜单**，确保没有新bug出现。"

   ⚠️ **层级划分（绝不动一级菜单）**：
     · 一级 = 挂件自己的 ☰ 菜单 → `.dshwv-menu` / `.dshwv-pop`
       —— 本模块**完全不匹配** `.dshwv-*`，一行都不碰。
     · 二级 = `.dshrice-menu`（偷吃白饭的面板）/ `.dshpet-exp-panel`（形象与互动设置）
     · 三级 = `.dshpet-exp-cfg`（设置里的子分区）

   ⚠️ **为什么必须用 !important**：
     rice 自己的 `placeMenu()` 每 700ms 会把面板的 `left` 重写回"贴在她旁边"，
     `whale-expression.js` 里也有一套每帧贴住菜单的复核。只改行内样式会被它们盖掉，
     必须用一条**带 !important 的样式规则**压住（和 rice-entry.js 的 dshpet-presspin
     是同一手法 —— 这里把它扩展成"居中 + 可拖"）。

   ⚠️ **拖动不改 left/top 行内值，只改那条 !important 规则**：
     行内值是 rice 的地盘，改它会在它下一次 placeMenu 时被抹掉；
     改规则则是持续生效的，且面板关闭时整条规则清空，不留痕迹。
   =========================================================================== */
(function () {
  'use strict'

  // ⚠️⚠️ **二级/三级面板清单。**
  //    ⚠️ **绝对不要加 `.dshwv-menu` / `.dshwv-menuview` / `.dshwv-menu-btn`**
  //       —— 那是一级菜单（挂件自己的 ☰），用户明确要求不许动。
  //    ⚠️ 也不要加 `.dshwv-*mask`（全屏遮罩）—— 那是点外部关闭用的透明层，
  //       居中没有意义，动它反而可能影响"点外面关闭"。
  //    下面这些是**挂件自带的面板**（用户说的"全局设置/按压泡泡设置/自定义"就是它们），
  //    类名是从 vendor/whale/assets/whale-widget.js 里核对出来的：
  //      soundPanelBtn（全局设置）→ dshwv-linepanel
  //      bubbleCustomBtn（按压泡泡设置）→ dshwv-custmenu
  //      自定义字体/颜色/队列 → dshwv-fontmenu / dshwv-rgbmenu / dshwv-qcolmenu
  var PANEL_SEL = [
    '.dshrice-menu',          // rice 的面板（二级）
    '.dshpet-exp-panel',      // 形象与互动设置（二级）
    '.dshpet-exp-cfg',        // 它的子分区（三级）
    '.dshwv-linepanel',       // 全局设置
    '.dshwv-custmenu',        // 按压泡泡设置
    '.dshwv-fontmenu',
    '.dshwv-rgbmenu',
    '.dshwv-qcolmenu',
    '.dshwv-usagepanel',      // 用量面板
    '.dshwv-audiowin',
    '.dshwv-confirmwin',
    '.dshwv-cropwin',
    '.dshwv-gifwin',
    '.dshwv-snapwin',
  ].join(', ')
  // 打开态判定：rice 面板加 .dshrice-open；exp 面板用 display 判定（见 isOpen）
  var CSS_ID = 'dshpet-panel-center-css'
  // 我们自己加到面板上的类（applyPos 用它做选择器；release 时摘掉，不留痕迹）
  var CENTER_CLS = 'dshpet-panel-center'

  var styleEl = null
  var active = null        // 当前被接管的面板
  var pos = null           // { left, top } —— 用户拖到哪就记哪；null = 还没定过，用居中
  var dragging = null      // { startX, startY, baseLeft, baseTop }

  function log(msg) {
    try { if (window.petApi && window.petApi.log) window.petApi.log('[面板居中] ' + msg) } catch (e) {}
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return styleEl
    styleEl = document.createElement('style')
    styleEl.id = CSS_ID
    styleEl.textContent = ''
    document.head.appendChild(styleEl)
    return styleEl
  }

  function clearStyle() {
    try { if (styleEl) styleEl.textContent = '' } catch (e) {}
  }

  function isOpen(el) {
    if (!el || !el.isConnected) return false
    try {
      var cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      if (parseFloat(cs.opacity) === 0) return false
      var r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    } catch (e) { return false }
  }

  // 屏幕正中央（用**工作区**尺寸，任务栏不影响视觉居中）
  function centerFor(el) {
    var r = el.getBoundingClientRect()
    var sw = window.screen && window.screen.availWidth ? window.screen.availWidth : window.innerWidth
    var sh = window.screen && window.screen.availHeight ? window.screen.availHeight : window.innerHeight
    return {
      left: Math.round((sw - r.width) / 2),
      top: Math.round((sh - r.height) / 2),
    }
  }

  // 把位置写成一条带 !important 的规则 —— 这样 rice 的 placeMenu / 贴菜单复核都压不过它。
  // ⚠️ 用**我们自己加的类**（CENTER_CLS）做选择器，而不是按面板原有的类名拼规则：
  //    这样不管面板叫什么、有几个类，规则都能命中，也不用逐个维护类名表。
  function applyPos(el, left, top) {
    try {
      if (!el.classList.contains(CENTER_CLS)) el.classList.add(CENTER_CLS)
      ensureStyle().textContent =
        '.' + CENTER_CLS + '{left:' + left + 'px !important;top:' + top + 'px !important;' +
        'right:auto !important;bottom:auto !important;transform:none !important;' +
        'position:fixed !important}'
    } catch (e) {}
  }

  function takeOver(el) {
    if (active === el) return
    active = el
    pos = null                       // 换了面板 → 回到居中
    dragging = null
    log('接管面板 ' + (el.className || '').split(' ')[0])
    applyPos(el, centerFor(el).left, centerFor(el).top)
    // 尺寸可能还没量准（刚插入 DOM），下一帧再校一次
    requestAnimationFrame(function () {
      if (active !== el || pos) return
      var c = centerFor(el)
      applyPos(el, c.left, c.top)
    })
  }

  function release() {
    if (!active) return
    log('放开面板')
    try { active.classList.remove(CENTER_CLS) } catch (e) {}
    active = null
    pos = null
    dragging = null
    clearStyle()
  }

  // —— 拖动 ——
  // 只认面板本身（不是里面的输入控件）。用 capture 阶段，且只在真的移动后才
  // preventDefault，避免影响面板里按钮的点击。
  function onPointerDown(e) {
    if (!active) return
    if (!active.contains(e.target)) return
    // 点在交互控件上就不拖（输入框/按钮/滑块/下拉/可编辑区）
    var t = e.target
    var tag = t && t.tagName ? String(t.tagName).toLowerCase() : ''
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' ||
        tag === 'option' || tag === 'label' || tag === 'a') return
    if (t && t.isContentEditable) return
    if (e.button !== undefined && e.button !== 0) return      // 只左键

    var r = active.getBoundingClientRect()
    dragging = { startX: e.clientX, startY: e.clientY, baseLeft: Math.round(r.left), baseTop: Math.round(r.top), moved: false }
  }

  function onPointerMove(e) {
    if (!dragging || !active) return
    var dx = e.clientX - dragging.startX
    var dy = e.clientY - dragging.startY
    if (!dragging.moved) {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return     // 抖动阈值，避免误触
      dragging.moved = true
      try { document.body.style.cursor = 'grabbing' } catch (err) {}
    }
    try { e.preventDefault() } catch (err) {}
    var left = dragging.baseLeft + dx
    var top = dragging.baseTop + dy
    // 别让它被拖出屏幕（留 40px 可见，保证还能拖回来）
    var sw = window.screen && window.screen.availWidth ? window.screen.availWidth : window.innerWidth
    var sh = window.screen && window.screen.availHeight ? window.screen.availHeight : window.innerHeight
    var w = active.offsetWidth, h = active.offsetHeight
    left = Math.max(-(w - 40), Math.min(left, sw - 40))
    top = Math.max(0, Math.min(top, sh - 40))
    pos = { left: Math.round(left), top: Math.round(top) }
    applyPos(active, pos.left, pos.top)
  }

  function onPointerUp() {
    if (!dragging) return
    var moved = dragging.moved
    dragging = null
    try { document.body.style.cursor = '' } catch (err) {}
    if (moved && pos) log('拖到 ' + pos.left + ',' + pos.top)
  }

  function scan() {
    var el = null
    try {
      var list = document.querySelectorAll(PANEL_SEL)
      for (var i = 0; i < list.length; i++) {
        if (isOpen(list[i])) { el = list[i]; break }
      }
    } catch (e) { return }
    if (el) {
      if (active !== el) takeOver(el)
    } else if (active) {
      release()
    }
  }

  function start() {
    if (window.__dshpetPanelCenter) return
    window.__dshpetPanelCenter = true
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    // 面板是随时开合的（rice 700ms 重排、exp 面板动态插入），用轮询最省心也最稳。
    // 200ms 一次、只做一次 querySelectorAll + 可见性判断，开销可忽略。
    setInterval(scan, 200)
    scan()
    log('已就绪（二级/三级菜单居中 + 可拖动；一级菜单不碰）')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})();
