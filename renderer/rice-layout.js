// ============================================================================
// 米粒面板「版面」修补：让带单位的行**永远不换行**
// ============================================================================
// 用户报的问题：唱歌那一栏里「最少隔」右边的「分钟」**有时候会掉到下一行去**。
//
// 根因（两个叠在一起）：
//   ① rice 的行样式是 `.dshrice-row{display:flex;...;flex-wrap:wrap}` ——
//      wrap 是它自己留的"保险"（怕以后往一行里塞多了溢出菜单）。
//   ② 那个 `<input type=range>` **没有设过宽度**，用的是浏览器默认宽度；
//      而作为 flex 子项，它的 `min-width` 默认是 `auto` ——
//      对 replaced element（input）来说这等于"内在最小宽度"，**根本压不下去**。
//   于是当行里的内容刚好超一点点（数字从 1 位变 2 位、字体度量不同、
//   面板被视口夹窄……），最后那个「分钟」就被 wrap 顶到下一行。
//   因为触发条件是"刚好超一点点"，所以表现就是**有时**错位。
//
// 修法（只在外壳里改 CSS，vendor 保持原版）：
//   · 给这种行打上 .dshpet-rangerow
//   · 该行 flex-wrap:nowrap（不许换行）
//   · 滑块 flex:1 1 auto + **min-width:0**（允许被压缩，这是关键那一条）
//   · 数字和单位 flex:0 0 auto + white-space:nowrap（绝不被压缩、绝不内部断行）
//   这样单位**无论如何**都和标签在同一行；空间不够时压缩的是滑块。
//
// ⚠️ 为什么不直接用 CSS `:has()`：
//   它更简洁，但依赖引擎版本；这里用 JS 打类名 + 普通选择器，
//   在旧引擎上同样成立，而且"哪些行被处理了"在自检里可以直接数出来。
(function () {
  'use strict'
  var api = window.petApi || {}
  function log(m) { try { if (api.log) api.log('[米粒版面] ' + m) } catch (e) {} }

  function ensureCss() {
    if (document.getElementById('dshpet-rice-layout-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-rice-layout-css'
    st.textContent = [
      // 带滑块的行：不许换行，且整行文本也不许在内部断行
      '.dshrice-menu .dshrice-row.dshpet-rangerow{flex-wrap:nowrap;white-space:nowrap}',
      // 滑块：可压缩（min-width:0 是关键 —— 默认的 auto 让它压不下去）
      '.dshrice-menu .dshrice-row.dshpet-rangerow > input[type=range]{flex:1 1 auto;min-width:0}',
      // 数字与单位：不压缩、不断行，永远留在同一行
      '.dshrice-menu .dshrice-row.dshpet-rangerow > .dshrice-num{flex:0 0 auto;white-space:nowrap}',
      '.dshrice-menu .dshrice-row.dshpet-rangerow > .dshrice-mut{flex:0 0 auto;white-space:nowrap}',
    ].join('')
    document.head.appendChild(st)
  }

  // 给"直接含滑块"的行打类名。只看直接子元素 —— 面板里别的地方也有 input。
  function tagRows() {
    var menu = document.querySelector('.dshrice-menu')
    if (!menu) return false
    var rows = menu.querySelectorAll('.dshrice-row')
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      var hasRange = false
      for (var c = 0; c < r.children.length; c++) {
        var el = r.children[c]
        if (el.tagName === 'INPUT' && String(el.type) === 'range') { hasRange = true; break }
      }
      if (hasRange) r.classList.add('dshpet-rangerow')
    }
    return true
  }

  // 面板是 rice 初始化时一次性建好的，可能比我们晚；建好后一般不再重建。
  // 这里既重试、也盯住它的 childList（万一将来它改成重建行）。
  var obs = null
  function start() {
    ensureCss()
    var tries = 0
    var t = setInterval(function () {
      tries++
      if (tagRows() || tries > 60) clearInterval(t)
    }, 500)
    tagRows()
    try {
      var menu = document.querySelector('.dshrice-menu')
      if (menu && !obs) {
        obs = new MutationObserver(function () { tagRows() })
        obs.observe(menu, { childList: true, subtree: true })
      }
    } catch (e) {}
    log('版面修补已就绪')
    return true
  }

  window.__dshpetRiceLayout = {
    start: start, tagRows: tagRows,
    count: function () { return document.querySelectorAll('.dshrice-row.dshpet-rangerow').length },
  }
})()
