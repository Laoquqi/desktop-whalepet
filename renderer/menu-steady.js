// ============================================================================
// 菜单稳态（最终版）：启动预热
// ============================================================================
// 跳动根因（CDP 逐帧实测）：菜单盒 shrink-to-fit，打开 ~255ms 后一次异步
// 内容回填让盒子 319→334、行折行致高度 788↔663 —— 开/关/记账返回的全部
// "弹一下/瞬移"都源于这 15px 宽度差的内容重排。
// 修复已收敛为两条纯 CSS（shell.css）：
//   · .dshwv-menu{ width:340px !important }   —— 盒子宽度恒定（vendor
//     max-width 上限），内容更新只在盒内回填，零重排；
//   · .dshwv-menu{ transition: ... ease }     —— 去掉 vendor 过冲曲线。
// 开合动画全部回到 vendor 原生淡入淡出，本文件只剩启动预热（隐形开合
// 一次，把首开才会建的懒内容提前建好）。
// ⚠️ 自检模式不干活。
(function () {
  'use strict'
  var api = window.petApi || {}
  if (api.selftest) return

  function log(m) { try { if (api.log) api.log('[菜单稳态] ' + m) } catch (e) {} }

  // 启动预热：隐形开合一次（用户恰好在开菜单时让位）
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
      }, 420)
      log('预热完成')
    } catch (e) {}
  }

  // —— 菜单打开/内容变化的同帧限高 ——
  // menu-fit 的 300ms 轮询会让"自然高度 788 → 限高 663"的钳制迟到 300ms，
  // 用户看到菜单先以超高状态出现再缩回去（跳动）。这里盯住菜单的 class
  // 与子树样式：打开的那一帧、以及菜单内部样式变化（记账返回重建等）的
  // 同一帧，直接调 menu-fit 的 fit() —— 限高从第一帧就生效。
  var fitObs = null
  function watchFit() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu || fitObs) return !!menu
    fitObs = new MutationObserver(function () {
      try {
        if (menu.classList.contains('dshwv-menu-open') && window.__dshpetMenuFitApi) {
          window.__dshpetMenuFitApi.fit()
        }
      } catch (e) {}
    })
    fitObs.observe(menu, { attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true })
    return true
  }
  function start() {
    var tries = 0
    var t = setInterval(function () {
      tries++
      if (watchFit()) clearInterval(t)
      else if (tries > 60) clearInterval(t)
    }, 250)
    watchFit()
    setTimeout(prewarm, 2000)
    setTimeout(prewarm, 5000)
    log('已就绪')
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
