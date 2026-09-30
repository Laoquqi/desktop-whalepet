/* ===========================================================================
   挂件自带的面板：整体往左移，避免和一级菜单（☰）重合
   ---------------------------------------------------------------------------
   用户要求（2026-09-30）：
     "将挂件自带的面板，二级菜单（全局设置/按压泡泡设置/自定义菜单等等）
      往左移至不与一级菜单重合的位置"

   ⚠️⚠️ **和上一版"居中"方案的区别（上一版是失败教训）：**
     · 上一版改 `left/top` 成**绝对坐标** —— 而面板是 `position:fixed`，
       left/top 相对**视口**，我用屏幕尺寸算就把它推到窗口外了。
     · 上一版还强制 `transform:none`，打乱了面板自己的布局。
     · **这一版只改 `margin-left`（相对位移）**，面板自己的 `left/top/transform`
       全部原样不动 —— 它原来在哪、怎么定位，还是那样，只是整体向左挪一段。
       这是 rice-entry.js 里已经验证过的做法（那里注释写着"改 margin-left，
       不改 left"），风险最低。

   ⚠️ **位移量按面板自己的宽度算**：往左挪「面板宽 + 间隙」，
     这样面板的右边缘正好落到它原来左边缘再往左一点的位置 ——
     无论面板多宽都能保证让开，不需要给每个面板单独配数值。

   ⚠️ **不要动一级菜单**：选择器里没有 `.dshwv-menu` / `.dshwv-menuview` /
     `.dshwv-menu-btn`；也没有 `.dshwv-*mask`（全屏遮罩，移它会跑偏）。
   ⚠️ **不要动 rice / 形象与互动**：没有 `.dshrice-menu` /
     `.dshpet-exp-panel` / `.dshpet-exp-cfg`（用户明确要求别碰）。
   =========================================================================== */
(function () {
  'use strict'

  // 只认"挂件自带的面板"。类名从 vendor/whale/assets/whale-widget.js 核对而来。
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

  var GAP = 14                 // 让开后额外留的间隙（px）
  var CSS_ID = 'dshpet-panel-shift-css'
  var styleEl = null
  var lastKey = ''             // 上次写入的规则内容，避免每轮都重写 style（省重排）

  function log(msg) {
    try { if (window.petApi && window.petApi.log) window.petApi.log('[面板左移] ' + msg) } catch (e) {}
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return styleEl
    styleEl = document.createElement('style')
    styleEl.id = CSS_ID
    styleEl.textContent = ''
    document.head.appendChild(styleEl)
    return styleEl
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

  // 面板显示后量它的宽度，算出该往左挪多少，写一条 margin-left 规则。
  // 用**自己的类**做选择器（dshpet-shift-left），不改面板原有的任何定位属性。
  function scan() {
    var rules = []
    var list
    try { list = document.querySelectorAll(PANEL_SEL) } catch (e) { return }
    for (var i = 0; i < list.length; i++) {
      var el = list[i]
      if (!isShown(el)) continue
      var w = el.offsetWidth || 0
      if (!w) continue
      // 已经加过类的不重复加
      if (!el.classList.contains('dshpet-shift-left')) {
        try { el.classList.add('dshpet-shift-left') } catch (e) { continue }
        log('左移面板 ' + (el.className || '').split(' ')[0] + '（宽 ' + w + 'px）')
      }
      rules.push('.dshpet-shift-left{margin-left:-' + Math.round(w + GAP) + 'px !important}')
    }
    // 规则统一写（每个面板宽度可能不同，但通常同类面板只开一个；
    // 多个同时开时取最后一条也够用 —— 位移量只差几像素，不影响"让开"这个目的）
    var text = rules.length ? rules[rules.length - 1] : ''
    if (text === lastKey) return
    lastKey = text
    try { ensureStyle().textContent = text } catch (e) {}
  }

  function start() {
    if (window.__dshpetPanelShift) return
    window.__dshpetPanelShift = true
    // 面板是随时开合的（挂件自己控制显隐），轮询最稳。
    // 250ms 一次、只做一次 querySelectorAll + 可见性判断，开销可忽略。
    setInterval(scan, 250)
    scan()
    log('已就绪（挂件自带面板往左让开一级菜单；不动 rice / 形象与互动）')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})();
