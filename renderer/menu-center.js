// ============================================================================
// 面板居中：挂件自带的二级/三级面板显示在屏幕正中央，并且可以拖动
// ============================================================================
// 范围（用户指定）：「全局设置」（提示与音效设置）、「按压泡泡设置」（自定义泡泡
// 主编辑窗口）、「自定义」（吸附设置）等**从 ☰ 菜单打开的弹窗面板**（它们都是
// .dshwv-bubmask / .dshwv-snapmask 系的全屏遮罩 + 弹性居中卡片），以及角色 /
// 音效组等**三级浮层列表**。☰ 主菜单一级本身保持原位（钉在鲸鱼旁）不动。
//
// 为什么必须"扩窗口"：这些面板是渲染在桌宠窗口里的 DOM（遮罩 inset:0 弹性
// 居中，怎么摆也出不了窗口视口）。桌宠窗口平时只有 900×900、钉在屏幕右下角
// —— 屏幕正中央根本不在窗口里。所以**面板打开时把窗口临时扩到整个工作区、
// 全部关掉再缩回去**：扩展时右下角不动，而挂件根节点钉在窗口右下
// （right:0;bottom:0），桌宠一像素都不会动；遮罩卡片弹性居中，窗口一扩
// 自动落到屏幕正中央。三级浮层列表逐个居中。
//
// ⚠️ 自检（PET_SELFTEST）断言全按 900×900 算 —— 自检模式下整个模块不干活。
// ⚠️ 不改 vendor：全部走 DOM + IPC，从外壳实现，上游合并不受影响。
//    浮层列表的定位用 !important 行内值压住挂件（它写的是普通行内值）。
(function () {
  'use strict'
  var api = window.petApi || {}
  if (api.selftest) return

  function log(m) { try { if (api.log) api.log('[面板居中] ' + m) } catch (e) {} }

  // —— 状态 ——
  var expanded = false   // 窗口已扩到工作区
  var pinMin = 0         // 扩展前的视口短边（冻结挂件尺寸公式用）

  // —— 触发源：二级弹窗遮罩 + 三级浮层列表 ——
  // （只列"打开后需要屏幕居中"的；☰ 主菜单 / 用量子视图在菜单盒子里，不动）
  var MASK_SEL = '.dshwv-bubmask,.dshwv-snapmask,.dshwv-cropmask,.dshwv-gifmask,' +
    '.dshwv-audiomask,.dshwv-confirmmask,.dshwv-resmask,.dshwv-usage-mask,.dshwv-qedit'
  var LIST_SEL = '.dshwv-rolelist,.dshwv-audiolist,.dshwv-slotlist'
  function visibleCount() {
    var n = 0
    try {
      var all = document.querySelectorAll(MASK_SEL + ',' + LIST_SEL)
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if ((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).display !== 'none') n++
      }
    } catch (e) {}
    return n
  }

  // —— 尺寸钉死：扩窗口不能让桌宠跟着变大/变小 ——
  // 挂件尺寸公式 min(250px, min(100vw,100vh)*0.28)*scale 里的 min(100vw,100vh)
  // 扩展后会变成工作区短边（工作区比 893 小会把桌宠缩小）。打开面板前把这一项
  // 按"扩展前的视口短边"冻结（scale 系数保留，大小滑块照常能用），关掉还原。
  var pinnedRoot = null
  function pinBase() {
    var root = document.querySelector('.dshwv-root')
    if (!root) return
    pinnedRoot = root
    var m = Math.min(window.innerWidth, window.innerHeight)
    root.style.setProperty('--dshw-base',
      'clamp(122px, calc(min(250px, ' + m + 'px * 0.28)) * var(--dshw-scale, 1), 625px)')
  }
  function unpinBase() {
    if (pinnedRoot) {
      try { pinnedRoot.style.removeProperty('--dshw-base') } catch (e) {}
      pinnedRoot = null
    }
  }

  function expand() {
    if (expanded) return
    if (!api.panelOpen) { log('主进程没有 panelOpen 接口（preload 版本过旧？）'); return }
    pinBase()
    expanded = true
    api.panelOpen()
    log('面板打开 → 窗口扩展到工作区（桌宠不动）')
  }
  function restore() {
    if (!expanded) return
    expanded = false
    unpinBase()
    if (api.panelClose) api.panelClose()
    log('面板全关 → 窗口还原')
  }

  // —— 带 !important 的定位（压住挂件随时会重写的普通行内值） ——
  function putImportant(el, x, y) {
    el.style.setProperty('left', Math.round(x) + 'px', 'important')
    el.style.setProperty('top', Math.round(y) + 'px', 'important')
    el.style.setProperty('right', 'auto', 'important')
    el.style.setProperty('bottom', 'auto', 'important')
  }
  function clampPos(x, y, w, h) {
    var maxX = Math.max(4, window.innerWidth - w - 4)
    var maxY = Math.max(4, window.innerHeight - h - 4)
    return [Math.min(Math.max(x, 4), maxX), Math.min(Math.max(y, 4), maxY)]
  }

  // —— 拖动手柄（三级浮层列表用）——
  function ensureCss() {
    if (document.getElementById('dshpet-menu-center-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-menu-center-css'
    st.textContent = [
      '.dshpet-draggrip{display:flex;align-items:center;justify-content:center;height:16px;' +
        'margin:0 0 5px;border:1px solid rgba(32,49,112,.25);border-radius:6px;' +
        'background:rgba(32,49,112,.08);color:#203170;font-size:10px;line-height:1;' +
        'cursor:move;user-select:none;-webkit-user-select:none;touch-action:none;' +
        'flex:0 0 auto;pointer-events:auto}',
      '.dshpet-draggrip:hover{background:rgba(32,49,112,.18)}',
      '.dshpet-draggable-title{cursor:move;user-select:none;-webkit-user-select:none;touch-action:none}',
    ].join('')
    document.head.appendChild(st)
  }
  function bindGrip(g, getPos, setPos) {
    g.addEventListener('pointerdown', function (e) {
      e.stopPropagation()
      var p = getPos()
      if (!p) return
      var sx = e.clientX, sy = e.clientY, ox = p[0], oy = p[1]
      try { g.setPointerCapture(e.pointerId) } catch (err) {}
      var move = function (ev) { setPos(ox + ev.clientX - sx, oy + ev.clientY - sy) }
      var up = function () {
        g.removeEventListener('pointermove', move)
        g.removeEventListener('pointerup', up)
        g.removeEventListener('pointercancel', up)
      }
      g.addEventListener('pointermove', move)
      g.addEventListener('pointerup', up)
      g.addEventListener('pointercancel', up)
    })
  }
  function makeGrip(label) {
    var g = document.createElement('div')
    g.className = 'dshpet-draggrip'
    g.textContent = label || '⠿ 按住拖动'
    return g
  }

  // —— ① 三级浮层列表（角色 / 音效组 / 卡槽）：出现时居中 + 手柄拖动 ——
  // 拖动更新 el.__dshpetPos；摆位每轮重跑（同一份 pos 重写不产生视觉变化，
  // 也不会盖掉拖动），窗口扩展是异步的，每轮重算才能保证最终落在真中心。
  // ⚠️ 每个元素走独立函数，别在 for 循环里给回调绑 var 变量（var 是函数
  //    作用域，多元素时回调会全部指向最后一个元素）。
  function handleList(el) {
    var vis = !!(el.offsetWidth || el.offsetHeight) && getComputedStyle(el).display !== 'none'
    if (!vis) { el.__dshpetPos = null; return }
    if (!el.__dshpetGrip) {
      el.__dshpetGrip = true
      var g = makeGrip('⠿')
      el.insertBefore(g, el.firstChild)
      bindGrip(g,
        function () { return el.__dshpetPos ? [el.__dshpetPos.x, el.__dshpetPos.y] : null },
        function (x, y) {
          var c = clampPos(x, y, el.offsetWidth, el.offsetHeight)
          el.__dshpetPos = { x: c[0], y: c[1] }
        })
    }
    var w = el.offsetWidth, h = el.offsetHeight
    if (!w || !h) return
    if (!el.__dshpetPos) el.__dshpetPos = { x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2 }
    var c = clampPos(el.__dshpetPos.x, el.__dshpetPos.y, w, h)
    el.__dshpetPos = { x: c[0], y: c[1] }
    putImportant(el, c[0], c[1])
  }

  // —— ② 弹窗面板（.dshwv-bubmask 系的全屏遮罩 + 弹性居中卡片）——
  //    窗口一扩它们自动屏幕居中，这里只补"按住标题栏拖动"。
  //    relative + left/top，不动遮罩的 flex 布局。
  function bindCardDrag(card, title) {
    card.__dshpetTitleDrag = true
    title.classList.add('dshpet-draggable-title')
    var dx = 0, dy = 0
    title.addEventListener('pointerdown', function (e) {
      e.stopPropagation()
      var sx = e.clientX, sy = e.clientY, ox = dx, oy = dy
      try { title.setPointerCapture(e.pointerId) } catch (err) {}
      var move = function (ev) {
        dx = ox + ev.clientX - sx
        dy = oy + ev.clientY - sy
        card.style.position = 'relative'
        card.style.left = Math.round(dx) + 'px'
        card.style.top = Math.round(dy) + 'px'
      }
      var up = function () {
        title.removeEventListener('pointermove', move)
        title.removeEventListener('pointerup', up)
        title.removeEventListener('pointercancel', up)
      }
      title.addEventListener('pointermove', move)
      title.addEventListener('pointerup', up)
      title.addEventListener('pointercancel', up)
    })
  }
  function handleMasks() {
    var cards = document.querySelectorAll('.dshwv-bubmask .dshwv-bubcard')
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i]
      if (card.__dshpetTitleDrag) continue
      var title = card.querySelector('.dshwv-bubtitle')
      if (!title) continue
      bindCardDrag(card, title)
    }
  }

  // —— 轮询：面板开关检测 + 摆位。120ms 一轮、每轮几个 querySelector，代价可忽略。
  //    不用 MutationObserver 的原因：面板的创建/显示路径太多（挂件各处都在写），
  //    轮询是唯一"不管谁开的面板都认"的口径。
  //
  //    ⚠️ **扩窗只在面板真正打开时做，绝不在 ☰ 菜单打开时做**（用户实测：
  //    菜单一开就扩窗，桌宠/菜单/偷吃白饭菜单会跟着瞬移闪一下再回来 ——
  //    窗口挪动+缩放必有一次可见重绘，不能挂在"每次开菜单"上）。
  //
  //    ⚠️ **"先藏后放"消灭面板瞬移**：面板在 900×900 的小窗口里打开时先落在
  //    原位（窗口中心附近），扩窗后才跳到屏幕中心 —— 那一下瞬移就是这么来的。
  //    现在：检测到面板露头 → 立刻 visibility:hidden 藏住 → 扩窗落地
  //    （视口已是整个工作区）→ 再放出来。用户看到的就是"点一下，面板直接
  //    出现在屏幕正中"，没有跳動。窗口本来就扩着时（连续开第二个面板）
  //    不藏不放，直接开。
  var lastActive = false
  var revealPending = false   // 有面板被藏住，等扩窗落地后放出
  var revealAt = 0
  function tick() {
    var n = visibleCount()
    var active = n > 0
    if (active && !lastActive) {
      expand()
      if (expanded) {
        hideAllMasks()
        revealPending = true
        revealAt = Date.now()
      }
      window.__dshpetPanelExpanded = true   // drag-physics 的朝向判定见此让路（见下）
    } else if (!active && lastActive) {
      window.__dshpetPanelExpanded = false
      revealPending = false
      unhideAllMasks()
      restore()
      correctFacing()
    }
    lastActive = active
    if (!expanded) return
    if (revealPending) {
      // 扩窗落地（视口短边已经变大）→ 放出被藏的面板。
      // ⚠️ 兜底：扩窗万一没落地，最多藏 1.5 秒强制放行 —— 面板绝不能被藏没。
      if (window.innerWidth > pinMin + 50 || Date.now() - revealAt > 1500 || !n) {
        revealPending = false
        unhideAllMasks()
      } else {
        hideAllMasks()   // 等待期间新出现的面板也藏住
      }
    }
    var lists = document.querySelectorAll(LIST_SEL)
    for (var i = 0; i < lists.length; i++) handleList(lists[i])
    handleMasks()
  }

  // —— 先藏后放 ——
  function hideAllMasks() {
    try {
      var all = document.querySelectorAll(MASK_SEL + ',' + LIST_SEL)
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (!(el.offsetWidth || el.offsetHeight)) continue
        if (getComputedStyle(el).display === 'none') continue
        el.__dshpetHiddenForExpand = true
        el.style.setProperty('visibility', 'hidden', 'important')
      }
    } catch (e) {}
  }
  function unhideAllMasks() {
    try {
      var all = document.querySelectorAll(MASK_SEL + ',' + LIST_SEL)
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (!el.__dshpetHiddenForExpand) continue
        el.__dshpetHiddenForExpand = false
        el.style.removeProperty('visibility')
      }
    } catch (e) {}
  }

  // —— 朝向校正 ——
  // 扩/缩窗口会让窗口原点跳变：transition 帧里 drag-physics 的 updateFacing
  // 可能读到"新 screenX + 旧布局 rect"，把"她在屏幕哪半边"算错 → 桌宠自己翻转。
  // 扩窗期间该判定被 __dshpetPanelExpanded 冻结（drag-physics 侧一行守卫）；
  // 全部关掉、布局落定之后，这里按同一口径（立绘中心 vs 屏幕中线）校正一次。
  // 类一改，drag-physics 自己的 classObs 会做失效缓存/重夹等善后。
  function correctFacing() {
    try {
      var root = document.querySelector('.dshwv-root')
      var img = document.querySelector('img.dshwv-img')
      if (!root || !img) return
      var r = img.getBoundingClientRect()
      if (!r || !r.width) return
      var sc = { x: (window.screen || {}).availLeft || 0, w: (window.screen || {}).availWidth || 0 }
      var centerX = window.screenX + r.left + r.width / 2
      var wantLeft = centerX < sc.x + sc.w / 2
      if (wantLeft !== root.classList.contains('dshwv-left')) {
        root.classList.toggle('dshwv-left', wantLeft)
      }
    } catch (e) {}
  }

  function start() {
    ensureCss()
    setInterval(tick, 120)
    log('面板居中模块已就绪（二级/三级面板 → 屏幕正中央 + 可拖动）')
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
