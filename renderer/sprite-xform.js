// ============================================================================
// 立绘 transform 合成器
// ============================================================================
// ⚠️⚠️ **为什么需要它**：立绘上同时有三路 transform 在抢：
//   · 点击 Q 弹（squash & stretch，pet-collide.js）
//   · 弹弓方向性形变（scale，drag-physics.js）
//   · 黄金回旋（rotate，golden-spin.js）
// 各自直接写 `img.style.transform` 的话会**互相覆盖** —— 表现是"转了半圈突然弹回"、
// "拉弹弓时回旋断掉"这类怪现象。所以统一走这里：每路只声明自己那一部分，
// 由这里按固定顺序合成。
//
// ⚠️ 只加在**立绘（img）**上，不加在根节点（.dshwv-root）——
//    measureArtRaw 摘行内 transform 时是 `while (el && el !== root)`，
//    **不会摘根节点**的；加在根上会污染 artOffset → 夹取/实体几何全错。
(function () {
  'use strict'

  var ORDER = ['sling', 'poke', 'spin']   // 合成顺序固定，保证可预期
  var parts = { sling: '', poke: '', spin: '' }
  var lastApplied = null

  function img() { return document.querySelector('img.dshwv-img') }

  function compose() {
    var out = []
    for (var i = 0; i < ORDER.length; i++) {
      var v = parts[ORDER[i]]
      if (v) out.push(v)
    }
    return out.join(' ')
  }

  function apply() {
    var el = img()
    if (!el) return
    var t = compose()
    if (t === lastApplied && el.style.transform === t) return
    lastApplied = t
    try { el.style.transform = t } catch (e) {}
  }

  // 设置某一路的 transform 片段（空串 = 清掉这一路）
  function set(part, value) {
    if (!(part in parts)) return false
    parts[part] = value ? String(value) : ''
    apply()
    return true
  }
  function clear(part) { return set(part, '') }
  function clearAll() {
    parts.sling = ''; parts.poke = ''; parts.spin = ''
    apply()
  }
  function get(part) { return parts[part] || '' }

  // 转成 CSS 片段的小工具
  function scale(x, y) { return 'scale(' + Number(x).toFixed(4) + ',' + Number(y).toFixed(4) + ')' }
  function rotate(deg) { return 'rotate(' + Number(deg).toFixed(2) + 'deg)' }

  window.__dshpetSpriteXform = {
    set: set, clear: clear, clearAll: clearAll, get: get, compose: compose, apply: apply,
    scale: scale, rotate: rotate,
    _parts: function () { return { sling: parts.sling, poke: parts.poke, spin: parts.spin } },
  }
})()
