// ============================================================================
// 黄金回旋（移植自参考实现的 pet/golden_spin.py）
// ============================================================================
// 程序化原地逆时针 360° 插值旋转，**不依赖素材**、也不和点击动画抢画面。
//
// 两种触发：
//   · 常规点击（arm_after_click）：点击动画播完 → consumeClickFinished() 接一圈
//   · 直连点击（goldenSpinDirect）：点击**立即**开转；旋转中再点 → 累计一圈 +
//     把当前圈剩余角度**快速收尾**（130ms），之后每圈比上一圈快（×0.82，下限 200ms）
//
// 旋转角度走 renderer/sprite-xform.js 的合成器（不然会和弹弓形变、点击 Q 弹互相覆盖）。
(function () {
  'use strict'
  var api = window.petApi || {}

  // ---- 常量（照抄 golden_spin.py，改动前先想清楚）----
  var DURATION_MS = 700          // 基准单圈时长
  var END_ANGLE = -360.0         // Qt 正角=顺时针，负角=逆时针 —— 这里同样是逆时针
  var ACCEL = 0.82               // 直连模式逐圈加速：下一圈 = 上一圈 × 0.82
  var MIN_REV_MS = 200           // 单圈时长下限，防长连击后转速失控
  var CLICK_RUSH_MS = 130        // 点击时把当前圈剩余角度快速转完的时长

  // OutCubic 缓动（对应 Qt 的 QEasingCurve.OutCubic）
  function easedProgress(elapsedMs, durationMs) {
    if (!(durationMs > 0)) return 1.0
    var raw = Math.max(0.0, Math.min(1.0, elapsedMs / durationMs))
    var inv = 1 - raw
    return 1 - inv * inv * inv
  }

  function xf() { return window.__dshpetSpriteXform }
  function log(m) { try { if (api.log) api.log('[回旋] ' + m) } catch (e) {} }

  // ---- 配置 ----
  var KEY_ON_CLICK = 'dshpet-golden-spin-on-click'
  var KEY_DIRECT = 'dshpet-golden-spin-direct'
  function readBool(key, dflt) {
    try {
      var v = localStorage.getItem(key)
      return v === null ? dflt : v === '1'
    } catch (e) { return dflt }
  }
  function writeBool(key, on) { try { localStorage.setItem(key, on ? '1' : '0') } catch (e) {} }
  function onClickEnabled() { return readBool(KEY_ON_CLICK, false) }
  function setOnClickEnabled(on) { writeBool(KEY_ON_CLICK, on); if (!on) cancelPending(); log('点击触发回旋 ' + (on ? '开' : '关')) }
  function directEnabled() { return readBool(KEY_DIRECT, false) }
  function setDirectEnabled(on) { writeBool(KEY_DIRECT, on); log('点击直连回旋 ' + (on ? '开' : '关')) }

  // ---- 状态机（和 GoldenSpinController 一一对应）----
  var active = false
  var angleDeg = 0.0
  var pendingAfterClick = false
  var remainingTurns = 0
  var nominalRevMs = DURATION_MS
  var revDurationMs = DURATION_MS
  var revStartedAt = 0
  var revStartAngle = 0.0
  var revEndAngle = END_ANGLE
  var timer = null

  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now() }

  function pushAngle() {
    var x = xf()
    if (!x) return
    // ⚠️ 回旋的 transform 写入必须**即时**。点击 Q 弹（pet-collide）/吃文件
    //    （file-eater）/换装（rice-role）的弹性动画会给 img 留下
    //    `transition: transform .28s` 且不清除 —— 回旋转完把 rotate(-360°)
    //    清回 0° 时，这个残留过渡会把"复位"补间成**整整一圈反向回转**
    //    （用户报的"转完一圈还会倒转一圈"）。Q 弹们每次写入前都自己显式
    //    设 transition，不依赖这里的残留值，所以关掉不影响它们的弹性。
    var img = document.querySelector('img.dshwv-img')
    if (img) { try { img.style.transition = 'none' } catch (e) {} }
    if (!active) { x.clear('spin'); return }
    x.set('spin', x.rotate(angleDeg))
  }

  function startTimer() {
    if (timer !== null) return
    // 16ms 精确节拍（对应参考实现的 PreciseTimer）
    timer = setInterval(function () { update(nowMs()) }, 16)
  }
  function stopTimer() { if (timer !== null) { clearInterval(timer); timer = null } }

  function beginSession(turns, revMs) {
    active = true
    remainingTurns = Math.max(1, turns | 0)
    nominalRevMs = Math.max(MIN_REV_MS, revMs | 0)
    revDurationMs = nominalRevMs
    angleDeg = 0.0
    revStartAngle = 0.0
    revEndAngle = END_ANGLE
    revStartedAt = nowMs()
    startTimer()
    pushAngle()
  }

  // 把当前圈从当前角度快速转完（约 CLICK_RUSH_MS）
  function rushCurrentRevolution() {
    revStartAngle = angleDeg
    revDurationMs = CLICK_RUSH_MS
    revStartedAt = nowMs()
  }

  function update(now) {
    if (!active) return
    var elapsedMs = Math.max(0.0, now - revStartedAt)
    var progress = easedProgress(elapsedMs, revDurationMs)
    angleDeg = revStartAngle + (revEndAngle - revStartAngle) * progress
    if (progress < 1.0) { pushAngle(); return }
    if (remainingTurns > 1) {
      // 当前圈完成 → 进入下一圈，并逐圈加速（普通圈时长用 nominal）
      remainingTurns -= 1
      nominalRevMs = Math.max(MIN_REV_MS, Math.round(nominalRevMs * ACCEL))
      revStartAngle = revEndAngle
      revEndAngle -= 360.0
      revDurationMs = nominalRevMs
      revStartedAt = now
      pushAngle()
      log('第 ' + remainingTurns + ' 圈，单圈 ' + revDurationMs + 'ms')
      return
    }
    // 全部转完
    active = false
    stopTimer()
    angleDeg = 0.0
    remainingTurns = 0
    nominalRevMs = DURATION_MS
    revDurationMs = DURATION_MS
    revStartAngle = 0.0
    revEndAngle = END_ANGLE
    pushAngle()
  }

  // ---- 对外 ----
  function start() {
    if (active) return
    beginSession(1, DURATION_MS)
    log('开转（基准 ' + DURATION_MS + 'ms）')
  }
  // 直连：空闲时开转一圈；旋转中再点 → 累计一圈 + 当前圈快速收尾
  function spinDirect() {
    if (active) {
      remainingTurns += 1
      rushCurrentRevolution()
      log('累计一圈（待转 ' + remainingTurns + '）')
    } else {
      beginSession(1, DURATION_MS)
      log('直连开转')
    }
  }
  function armAfterClick() { pendingAfterClick = true }
  function consumeClickFinished() {
    if (!pendingAfterClick) return
    pendingAfterClick = false
    start()
  }
  function cancel() {
    pendingAfterClick = false
    if (!active) { pushAngle(); return }
    active = false
    stopTimer()
    angleDeg = 0.0
    remainingTurns = 0
    nominalRevMs = DURATION_MS
    revDurationMs = DURATION_MS
    revStartAngle = 0.0
    revEndAngle = END_ANGLE
    pushAngle()
    log('已取消')
  }
  function cancelPending() { pendingAfterClick = false }

  // ---- 菜单入口 ----
  function injectMenuRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-spin-row')) return true
    var row = document.createElement('div')
    row.className = 'dshpet-spin-row'
    var b = document.createElement('button')
    b.type = 'button'
    b.textContent = '✨ 黄金回旋'
    b.title = '原地逆时针转一圈；转的过程中再点会越转越快'
    b.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 9px;' +
      'border:1px solid rgba(32,49,112,.5);border-radius:7px;background:rgba(32,49,112,.08);' +
      'color:#203170;font:12px/1.4 inherit;cursor:pointer;user-select:none;-webkit-user-select:none'
    b.addEventListener('click', function (e) {
      e.stopPropagation()
      start()
    })
    row.appendChild(b)
    // 点击反馈的两个子开关（对应参考实现的设置 → 桌宠行为 → 点击反馈）
    function mkToggle(key, text, getter, setter, title) {
      var wrap = document.createElement('label')
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:8px;cursor:pointer;color:#203170;font-size:12px'
      var cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = getter()
      cb.title = title
      cb.style.cssText = 'width:14px;height:14px;accent-color:#203170;cursor:pointer'
      cb.addEventListener('change', function (ev) { ev.stopPropagation(); setter(cb.checked) })
      cb.addEventListener('click', function (ev) { ev.stopPropagation() })
      var t = document.createElement('span')
      t.textContent = text
      wrap.appendChild(cb); wrap.appendChild(t)
      return wrap
    }
    row.appendChild(mkToggle('onclick', '点击触发', onClickEnabled, setOnClickEnabled,
      '点击她之后自动接一圈黄金回旋（等点击动画播完）'))
    row.appendChild(mkToggle('direct', '直连', directEnabled, setDirectEnabled,
      '点击直接开转、不等点击动画；转的过程中再点会越转越快'))
    // 插在「弹弓」下面（都是"动作"这一类的）
    var base = menu.querySelector('.dshpet-sling-row') || menu.querySelector('.dshpet-strength-row') ||
      menu.querySelector('.dshpet-phys-row')
    if (base && base.parentNode) base.parentNode.insertBefore(row, base.nextSibling)
    else menu.appendChild(row)
    return true
  }

  // ---- 点击检测 ----
  // 和拖拽区分：**按下到抬起要短、位移要小**。用立绘矩形判断"点在不在她身上"
  // （不能看 e.target —— 她的 DOM 是 pointer-events:none，target 永远是 body）。
  var CLICK_MAX_MS = 350
  var CLICK_MAX_PX = 6
  var dT = 0, dX = 0, dY = 0, dOn = false

  function onWhale(x, y) {
    var img = document.querySelector('img.dshwv-img')
    if (!img) return false
    var r
    try { r = img.getBoundingClientRect() } catch (e) { return false }
    if (!r || r.width <= 0) return false
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }

  function onDown(e) {
    if (e.button !== 0) return
    dOn = onWhale(e.clientX, e.clientY)
    if (!dOn) return
    dT = nowMs(); dX = e.clientX; dY = e.clientY
  }

  function onUp(e) {
    if (!dOn || e.button !== 0) { dOn = false; return }
    dOn = false
    var dt = nowMs() - dT
    var dist = Math.hypot(e.clientX - dX, e.clientY - dY)
    if (dt > CLICK_MAX_MS || dist > CLICK_MAX_PX) return   // 是拖拽，不是点击
    if (!onClickEnabled()) return
    if (directEnabled()) {
      // 直连：点击**立即**开转（跳过等待点击动画）
      spinDirect()
    } else {
      // 常规：等点击动画播完再接一圈（由 pet-collide 的 poke() 结束时回调）
      armAfterClick()
    }
  }

  function boot() {
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)

    var tries = 0
    var t = setInterval(function () {
      tries++
      if (window.__dshpetOnMenuReady ? window.__dshpetOnMenuReady(injectMenuRow) : injectMenuRow()) {
        clearInterval(t)
      } else if (tries > 40) clearInterval(t)
    }, 250)
    if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(injectMenuRow)
    else injectMenuRow()
    log('已就绪（点击触发=' + (onClickEnabled() ? '开' : '关') +
      ' 直连=' + (directEnabled() ? '开' : '关') + '）')
  }

  window.__dshpetGoldenSpin = {
    boot: boot, start: start, spinDirect: spinDirect,
    armAfterClick: armAfterClick, consumeClickFinished: consumeClickFinished,
    cancel: cancel, cancelPending: cancelPending,
    isActive: function () { return active }, angle: function () { return angleDeg },
    queuedTurns: function () { return remainingTurns },
    onClickEnabled: onClickEnabled, setOnClickEnabled: setOnClickEnabled,
    directEnabled: directEnabled, setDirectEnabled: setDirectEnabled,
    injectMenuRow: injectMenuRow,
    _consts: { DURATION_MS: DURATION_MS, END_ANGLE: END_ANGLE, ACCEL: ACCEL,
      MIN_REV_MS: MIN_REV_MS, CLICK_RUSH_MS: CLICK_RUSH_MS },
  }
})()
