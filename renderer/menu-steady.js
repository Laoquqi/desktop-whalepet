// ============================================================================
// 菜单稳态：开 ☰ 菜单不跳、不闪、不"加载一下"
// ============================================================================
// 实测（CDP 逐帧采样）：每次打开菜单，菜单盒都会先以旧几何出现（306×756、
// 顶边 -76），然后 300ms 内宽度长到 334、行换行重排导致高度 756→786→663
// 跳动 —— 用户看到的就是"打开时卡一下、弹一下"。
//
// 两层修复：
//   ① 启动预热 —— 页面就绪后做一两次"隐形开合"（visibility:hidden 下加/
//      移除 dshwv-menu-open 类），把首开才会建的懒内容（异步行、面板）全部
//      提前建好；
//   ② 先藏后放 —— 监听到菜单打开（class 挂上）的同一帧先把菜单 visibility
//      藏起来，等宽度连续两帧稳定（或 400ms 兜底）再放出来 —— 用户看到的
//      菜单从一开始就是最终位置、最终尺寸，绝无跳动。
//
// 代价：开菜单的缩放/淡入动画会在隐藏期里播完，菜单表现为"立刻完整出现"。
// ⚠️ 自检模式整个模块不干活。
(function () {
  'use strict'
  var api = window.petApi || {}
  if (api.selftest) return

  function log(m) { try { if (api.log) api.log('[菜单稳态] ' + m) } catch (e) {} }

  var menu = null
  var obs = null
  var hiding = false

  function onOpen() {
    if (hiding) return
    hiding = true
    try { menu.style.setProperty('visibility', 'hidden', 'important') } catch (e) {}
    // ⚠️ 判稳必须用 getBoundingClientRect（含 transform 的渲染矩形）：
    //    打开后前 ~250ms 有缩放过渡 + 行重排，offsetWidth 对缩放无感，
    //    第一帧就"稳定"会立刻放行（第一版实测踩坑：308/761/-81 的中间态
    //    直接可见）。连续 3 帧稳定（或 450ms 兜底）才放出来。
    var stable = 0
    var last = ''
    var t0 = Date.now()
    var tick = function () {
      try {
        // 用户中途关掉了 → 直接放手
        if (!menu.classList.contains('dshwv-menu-open')) {
          menu.style.removeProperty('visibility')
          hiding = false
          return
        }
        var r = menu.getBoundingClientRect()
        // ⚠️ 0.1px 精度：整数舍入会把缩放动画的逐帧 ~1px 变化误判成"稳定"
        var key = r.width.toFixed(1) + 'x' + r.height.toFixed(1) + '@' + r.top.toFixed(1)
        stable = (key === last) ? stable + 1 : 0
        last = key
        // ⚠️ 还要够**最短隐藏时长**（260ms ≥ .22s 过渡）：贝塞尔曲线尾段
        //    变化 <0.1px/帧，会被误判稳定而提前放行（第一帧中间态实测踩坑）
        var elapsed = Date.now() - t0
        if ((elapsed >= 260 && stable >= 3) || elapsed > 450) {
          menu.style.removeProperty('visibility')
          hiding = false
          return
        }
        requestAnimationFrame(tick)
      } catch (e) {
        try { menu.style.removeProperty('visibility') } catch (e2) {}
        hiding = false
      }
    }
    requestAnimationFrame(tick)
  }

  function watch() {
    menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (!obs) {
      obs = new MutationObserver(function () {
        try { if (menu.classList.contains('dshwv-menu-open')) onOpen() } catch (e) {}
      })
      obs.observe(menu, { attributes: true, attributeFilter: ['class'] })
    }
    return true
  }

  // —— 启动预热：隐形开合一次，把懒内容提前建好 ——
  // 预热期间如果用户恰好开了菜单，就让位（不做预热）。
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
      if (watch()) { clearInterval(t) } else if (tries > 60) clearInterval(t)
    }, 250)
    watch()
    // 预热两次：2s（首次）+ 5s（兜底晚注入的行）
    setTimeout(prewarm, 2000)
    setTimeout(prewarm, 5000)
    log('已就绪')
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
