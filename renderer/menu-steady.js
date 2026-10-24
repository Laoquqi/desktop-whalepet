// ============================================================================
// 菜单稳态（精简版）：启动预热
// ============================================================================
// 历史与本文件的关系：
//   用户报"开 ☰ 菜单卡一下弹一下"，本文件第一版用 visibility 先藏后放 +
//   淡入重放 + 几何守卫硬拗，越修越多。后来 CDP 逐帧复盘发现真正的根因
//   是 vendor 的 transform 过渡用了 cubic-bezier(.34,1.3,.6,1)（y1=1.3
//   过冲 ~14%）：0.4.2 菜单变高后，过冲的像素幅度大到肉眼可见 —— 开/关/
//   记账返回三种"弹一下/瞬移"同源。该曲线已在 shell.css 里用标准 ease-out
//   覆盖（vendor 零改动），原生开合动画平滑，本文件第一版的所有补丁全部
//   撤销。
// 现在只剩：启动预热（隐形开合一次，把首开才会建的懒内容提前建好）。
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
      }, 350)
      log('预热完成')
    } catch (e) {}
  }

  function start() {
    setTimeout(prewarm, 2000)
    setTimeout(prewarm, 5000)
    log('已就绪')
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
