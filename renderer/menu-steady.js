// ============================================================================
// 菜单稳态：开 ☰ 菜单不跳、不闪、不"加载一下"
// ============================================================================
// 实测（CDP 逐帧采样）三类跳动：
//   ① 打开：菜单先以旧几何出现（306×756、顶边 -76），300ms 内宽度 306→335、
//      行换行重排致高度 756→786→663 跳动 —— 热身后也一样；
//   ② 关闭：渐出的 100ms 里内容回流（334→306），渐出过程肉眼可见地跳；
//   ③ 记账返回：主视图重建，菜单盒 334→319×788@-117→334"重新打开"式瞬移
//      （用户描述的"瞬间回到顶部"）。
//
// 统一修法（三段式）：
//   · 打开：同帧 visibility:hidden → 几何稳定（0.1px 精度连续 3 帧 + 最短
//     260ms + 450ms 兜底）→ **在最终几何上重放一次淡入**（补回打开动画）；
//   · 关闭：class 移除的同帧 visibility:hidden（渐出期间的回流跳动不可见，
//     菜单表现为干净地消失）；
//   · 开着期间：几何守卫 —— 矩形突然偏离稳定值（宽 >4px 或顶 >30px）就藏，
//     重新稳定后再放出（记账返回的瞬移因此不可见）。
// ⚠️ 判稳必须用 getBoundingClientRect（0.1px 精度 + 最短时长）：
//    offsetWidth 对缩放动画无感；整数舍入/贝塞尔尾段（<0.1px/帧）都会误判
//    稳定而提前放行（踩坑实录）。
// ⚠️ 自检模式整个模块不干活。
(function () {
  'use strict'
  var api = window.petApi || {}
  if (api.selftest) return

  function log(m) { try { if (api.log) api.log('[菜单稳态] ' + m) } catch (e) {} }

  var menu = null
  var obs = null
  var settling = false     // 打开/关闭/瞬移的隐藏期
  var lastStable = null    // 开着期间的稳定几何（"334x663@8"）
  var guardArmed = false   // 开着期间的几何守卫是否已武装

  function geomKey(r) { return r.width.toFixed(1) + 'x' + r.height.toFixed(1) + '@' + r.top.toFixed(1) }
  function rect() { return menu.getBoundingClientRect() }
  function hide() { try { menu.style.setProperty('visibility', 'hidden', 'important') } catch (e) {} }
  function show() { try { menu.style.removeProperty('visibility') } catch (e) {} }

  // 等几何稳定（连续 3 帧 0.1px 一致 + 最短 minMs + 上限 capMs）→ done()
  function waitStable(minMs, capMs, done) {
    var stable = 0
    var last = ''
    var t0 = Date.now()
    var tick = function () {
      try {
        var key = geomKey(rect())
        stable = (key === last) ? stable + 1 : 0
        last = key
        if ((Date.now() - t0 >= minMs && stable >= 3) || Date.now() - t0 > capMs) { done(); return }
        requestAnimationFrame(tick)
      } catch (e) { done() }
    }
    requestAnimationFrame(tick)
  }

  // 在最终几何上重放一次淡入（vendor 的过渡已在隐藏期播完，这里补回动画观感）
  function replayFadeIn() {
    try {
      menu.style.transition = 'opacity .18s ease'
      menu.style.opacity = '0'
      void menu.offsetWidth
      menu.style.opacity = '1'
      setTimeout(function () {
        try { menu.style.transition = ''; menu.style.opacity = '' } catch (e) {}
      }, 220)
    } catch (e) {}
  }

  // —— 打开：藏到稳定 → 重放淡入 → 武装几何守卫 ——
  function onOpen() {
    if (settling) return
    settling = true
    guardArmed = false
    lastStable = null
    hide()
    waitStable(330, 450, function () {
      show()
      replayFadeIn()
      lastStable = geomKey(rect())
      guardArmed = true
      settling = false
    })
  }

  // —— 关闭：class 移除的同帧藏掉（渐出期间的回流跳动不可见）——
  function onClose() {
    try {
      hide()
      guardArmed = false
      lastStable = null
      setTimeout(function () { try { if (!menu.classList.contains('dshwv-menu-open')) show() } catch (e) {} }, 300)
    } catch (e) {}
  }

  // —— 开着期间：几何守卫（记账返回的瞬移藏掉）——
  function guardTick() {
    try {
      if (!guardArmed || settling) return
      if (!menu.classList.contains('dshwv-menu-open')) { guardArmed = false; return }
      var r = rect()
      var key = geomKey(r)
      if (lastStable && key !== lastStable) {
        var dw = Math.abs(parseFloat(key.split('x')[0]) - parseFloat(lastStable.split('x')[0]))
        var dtop = Math.abs(parseFloat(key.split('@')[1]) - parseFloat(lastStable.split('@')[1]))
        if (dw > 4 || dtop > 30) {
          // 瞬移！藏到重新稳定再放出
          settling = true
          guardArmed = false
          hide()
          waitStable(180, 450, function () {
            show()
            lastStable = geomKey(rect())
            guardArmed = true
            settling = false
          })
        } else {
          lastStable = key   // 小幅变化（悬停高亮等）跟随
        }
      }
    } catch (e) {}
  }
  // 25ms 一轮（≈1 帧）：记账返回的瞬移最多露出一帧就藏掉
  setInterval(guardTick, 25)

  function watch() {
    menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (!obs) {
      obs = new MutationObserver(function () {
        try {
          if (menu.classList.contains('dshwv-menu-open')) onOpen()
          else onClose()
        } catch (e) {}
      })
      obs.observe(menu, { attributes: true, attributeFilter: ['class'] })
    }
    return true
  }

  // —— 启动预热：隐形开合一次，把首开才会建的懒内容提前建好 ——
  function prewarm() {
    try {
      var m = document.querySelector('.dshwv-menu')
      if (!m || m.classList.contains('dshwv-menu-open')) return
      m.style.setProperty('visibility', 'hidden', 'important')
      m.classList.add('dshwv-menu-open')
      setTimeout(function () {
        try {
          m.classList.remove('dshwv-menu-open')
          m.style.removeProperty('visibility')
        } catch (e) {}
      }, 350)
      log('预热完成')
    } catch (e) {}
  }

  function start() {
    var tries = 0
    var t = setInterval(function () {
      tries++
      if (watch()) clearInterval(t)
      else if (tries > 60) clearInterval(t)
    }, 250)
    watch()
    setTimeout(prewarm, 2000)
    setTimeout(prewarm, 5000)
    log('已就绪')
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
