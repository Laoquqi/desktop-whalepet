// ============================================================================
// 面板拖动：挂件自带的二级/三级面板可以按住标题栏/手柄拖到屏幕任何位置
// ============================================================================
// ⚠️⚠️ **不做"自动扩窗居中"，原因（四轮实测的结论）：**
//   面板要落在屏幕正中央，桌宠窗口就必须从 900×900 扩到能跨过屏幕中心 ——
//   而窗口尺寸一变，Chromium/DWM 重建合成层，会把正在播放的视频从硬件
//   叠加层（MPO）里挤出去：用户实测"开面板后视频卡住，要点一下才恢复"。
//   "面板屏幕居中"和"菜单绝不影响视频播放"在几何上不可兼得 ——
//   按用户的硬要求（视频优先），面板**在原位置打开**（与挂件原版一致），
//   但全部**可拖动**：想要它待在哪，拖过去即可（包括拖到屏幕正中）。
//
// 覆盖对象：
//   ① 弹窗面板（「全局设置」=提示与音效设置、「按压泡泡设置」=自定义泡泡主
//      编辑、「自定义」=吸附设置等 .dshwv-bubmask/.dshwv-snapmask 系的全屏
//      遮罩 + 弹性居中卡片）→ 按住标题栏（.dshwv-bubtitle）拖动；
//   ② 三级浮层列表（角色/音效组/卡槽）→ 顶部「⠿」手柄拖动。
//   ☰ 主菜单一级不动。
//
// ⚠️ 自检（PET_SELFTEST）断言全按无面板拖动算 —— 自检模式下整个模块不干活。
// ⚠️ 不改 vendor：全部走 DOM，从外壳实现，上游合并不受影响。
(function () {
  'use strict'
  var api = window.petApi || {}
  if (api.selftest) return

  function log(m) { try { if (api.log) api.log('[面板拖动] ' + m) } catch (e) {} }

  // —— 带 !important 的定位（压住挂件随时会重写的普通行内值；只认用户拖过的）——
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

      // ============ 液态玻璃皮肤（菜单 + 按键 + 列表 + 卡片）============
      // 玻璃配方：半透明白渐变底 + backdrop 模糊提饱和 + 白高光描边 +
      // 内侧上亮下暗两道内阴影 + 大圆角；深蓝 pill 按钮带渐变与浮起反馈。
      // 全部 !important 压过挂件样式表（我们的 <style> 注入得更晚）。
      // —— ☰ 菜单盒 ——
      '.dshwv-menu{' +
        'background:linear-gradient(148deg,rgba(255,255,255,.74) 0%,rgba(238,244,255,.55) 52%,rgba(255,255,255,.64) 100%) !important;' +
        'backdrop-filter:blur(18px) saturate(1.6) !important;' +
        '-webkit-backdrop-filter:blur(18px) saturate(1.6) !important;' +
        'border:1px solid rgba(255,255,255,.68) !important;' +
        'border-radius:18px !important;' +
        'padding:12px 14px !important;' +
        'box-shadow:0 18px 50px rgba(21,36,84,.26),0 2px 8px rgba(21,36,84,.12),' +
          'inset 0 1px 0 rgba(255,255,255,.9),inset 0 -1px 0 rgba(255,255,255,.3) !important;' +
        '}',
      // 斜向高光扫过（负 z-index：垫在内容下、浮在底色上）
      '.dshwv-menu::before{content:"";position:absolute;inset:0;border-radius:inherit;' +
        'pointer-events:none;z-index:-1;' +
        'background:linear-gradient(158deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 36%,' +
          'rgba(255,255,255,0) 64%,rgba(255,255,255,.26) 100%)}',
      // —— 菜单行：圆角悬停高亮 ——
      '.dshwv-menu-row{margin:4px -6px !important;padding:3px 6px !important;' +
        'border-radius:10px !important;transition:background .16s ease !important;}',
      '.dshwv-menu-row:hover{background:rgba(32,49,112,.08) !important;}',
      // —— ☰ 按钮：玻璃圆角方块 ——
      '.dshwv-menu-btn{background:rgba(32,49,112,.72) !important;' +
        'backdrop-filter:blur(10px) saturate(1.4) !important;' +
        'border:1px solid rgba(255,255,255,.4) !important;border-radius:9px !important;' +
        'box-shadow:0 4px 14px rgba(21,36,84,.32),inset 0 1px 0 rgba(255,255,255,.35) !important;' +
        'transition:transform .16s ease,background .16s ease,box-shadow .16s ease !important;}',
      '.dshwv-menu-btn:hover{background:rgba(47,68,136,.85) !important;transform:scale(1.08) !important;' +
        'box-shadow:0 6px 18px rgba(21,36,84,.4) !important;}',
      // —— 深蓝 pill 按钮（全局设置/按压泡泡设置/自定义/管理/小鲸鱼记账）——
      '.dshwv-roleimport{background:linear-gradient(180deg,rgba(52,74,148,.94),rgba(32,49,112,.94)) !important;' +
        'border:1px solid rgba(255,255,255,.3) !important;border-radius:10px !important;' +
        'padding:4px 12px !important;font-weight:600 !important;' +
        'box-shadow:0 3px 8px rgba(21,36,84,.3),inset 0 1px 0 rgba(255,255,255,.28) !important;' +
        'transition:transform .16s ease,box-shadow .16s ease,filter .16s ease !important;}',
      '.dshwv-roleimport:hover{filter:brightness(1.14) !important;transform:translateY(-1px) !important;' +
        'box-shadow:0 6px 16px rgba(21,36,84,.38) !important;}',
      '.dshwv-roleimport:active{transform:translateY(0) !important;filter:brightness(.94) !important;}',
      // —— 浅色玻璃控件（音效组选择/打开网页端按钮）——
      '.dshwv-audiobtn,.dshpet-openweb-btn{background:rgba(255,255,255,.55) !important;' +
        'border:1px solid rgba(32,49,112,.22) !important;border-radius:10px !important;' +
        'transition:background .16s ease,transform .16s ease !important;}',
      '.dshwv-audiobtn:hover,.dshpet-openweb-btn:hover{background:rgba(255,255,255,.82) !important;' +
        'transform:translateY(-1px) !important;}',
      // —— 输入控件：统一主题色 + 玻璃底 ——
      '.dshwv-range,.dshwv-check{accent-color:#2f4488 !important;}',
      '.dshwv-number{background:rgba(255,255,255,.62) !important;' +
        'border:1px solid rgba(32,49,112,.2) !important;border-radius:8px !important;}',
      // —— 三级浮层列表（角色/音效组/卡槽）：同款玻璃 ——
      '.dshwv-rolelist,.dshwv-audiolist,.dshwv-slotlist{' +
        'background:linear-gradient(150deg,rgba(255,255,255,.8),rgba(238,244,255,.66)) !important;' +
        'backdrop-filter:blur(14px) saturate(1.5) !important;' +
        '-webkit-backdrop-filter:blur(14px) saturate(1.5) !important;' +
        'border:1px solid rgba(255,255,255,.62) !important;border-radius:14px !important;' +
        'box-shadow:0 14px 38px rgba(21,36,84,.24),inset 0 1px 0 rgba(255,255,255,.85) !important;}',
      // —— 弹窗卡片（全局设置/按压泡泡设置/自定义等）——
      '.dshwv-bubcard,.dshwv-snapwin{' +
        'background:linear-gradient(152deg,rgba(255,255,255,.88),rgba(240,245,255,.78)) !important;' +
        'backdrop-filter:blur(16px) saturate(1.4) !important;' +
        '-webkit-backdrop-filter:blur(16px) saturate(1.4) !important;' +
        'border:1px solid rgba(255,255,255,.66) !important;border-radius:16px !important;' +
        'box-shadow:0 18px 48px rgba(21,36,84,.24),inset 0 1px 0 rgba(255,255,255,.9) !important;}',
      '.dshwv-bubtitle,.dshwv-snaptitle{font-weight:700 !important;}' +
        '',
      // —— 拖动手柄：融进玻璃语言 ——
      '.dshpet-draggrip{background:rgba(32,49,112,.06) !important;' +
        'border:1px solid rgba(32,49,112,.16) !important;border-radius:8px !important;}',
      '.dshpet-draggrip:hover{background:rgba(32,49,112,.14) !important;}',
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

  // —— ① 三级浮层列表（角色 / 音效组 / 卡槽）：「⠿」手柄拖动 ——
  // 挂件每次打开都会重写它们的位置（普通行内值）；用户拖过一次后用
  // !important 接管（el.__dshpetDragged），本次打开内保持拖到的位置；
  // 关掉再开回到挂件的默认位置（每次打开都从原位开始，符合直觉）。
  // ⚠️ 每个元素走独立函数，别在 for 循环里给回调绑 var 变量（var 是函数
  //    作用域，多元素时回调会全部指向最后一个元素）。
  function handleList(el) {
    var vis = !!(el.offsetWidth || el.offsetHeight) && getComputedStyle(el).display !== 'none'
    if (!vis) { el.__dshpetDragged = false; el.__dshpetPos = null; return }
    if (!el.__dshpetGrip) {
      el.__dshpetGrip = true
      var g = makeGrip('⠿')
      el.insertBefore(g, el.firstChild)
      bindGrip(g,
        function () { return el.__dshpetPos ? [el.__dshpetPos.x, el.__dshpetPos.y] : null },
        function (x, y) {
          el.__dshpetDragged = true
          var c = clampPos(x, y, el.offsetWidth, el.offsetHeight)
          el.__dshpetPos = { x: c[0], y: c[1] }
          putImportant(el, c[0], c[1])
        })
    }
    // 只有用户拖过的才持续接管位置（拖动过程中每轮重写同一份值，
    // 视觉无变化，但能压住挂件在打开瞬间写入的普通行内值）
    if (el.__dshpetDragged && el.__dshpetPos) {
      var w = el.offsetWidth, h = el.offsetHeight
      if (!w || !h) return
      var c = clampPos(el.__dshpetPos.x, el.__dshpetPos.y, w, h)
      el.__dshpetPos = { x: c[0], y: c[1] }
      putImportant(el, c[0], c[1])
    }
  }

  // —— ② 弹窗面板（.dshwv-bubmask 系遮罩 + 弹性居中卡片）：按住标题栏拖动 ——
  // relative + left/top，不动遮罩的 flex 布局；卡片每次打开都是新建的，
  // 拖动只在当次有效（关掉再开回到遮罩居中位）。
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

  // —— 轮询：面板出现即绑定拖动。150ms 一轮、每轮几个 querySelector，代价可忽略。
  //    不用 MutationObserver 的原因：面板的创建路径太多（挂件各处都在写），
  //    轮询是唯一"不管谁开的面板都认"的口径。
  function tick() {
    var lists = document.querySelectorAll('.dshwv-rolelist,.dshwv-audiolist,.dshwv-slotlist')
    for (var i = 0; i < lists.length; i++) handleList(lists[i])
    handleMasks()
  }

  function start() {
    ensureCss()
    setInterval(tick, 150)
    log('面板拖动模块已就绪（弹窗按标题栏、列表按 ⠿ 手柄拖动；不扩窗、不影响视频）')
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
