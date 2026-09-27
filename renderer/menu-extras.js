// ============================================================================
// 桌宠菜单扩展：删掉「避让滚动条 / 宽度」、加上「打开 dsh 网页端」
// ============================================================================
// 为什么放在外壳里、不改 vendor/whale/assets/whale-widget.js：
//   那个文件是上游的，改了就再也没法直接升级（本次刚做过一次上游合并，
//   就是因为之前只改了 rice 一个文件，才不得不手工重打补丁）。
//   菜单是 DOM，**在外壳里改 DOM** 既能达到同样效果，又能保住 vendor 干净。
(function () {
  'use strict'
  var api = window.petApi || {}

  // dsh web 的常见默认端口（**仅作参考**，实际由主进程探测）。
  // 上游 README 里是 `curl http://127.0.0.1:3080/dsh-whale/...` + "重启 dsh web"，
  // 所以 3080 是最常见的那个；但官方文档说端口是启动时打印的，不同机器不同。
  var DSH_WEB_HINT_PORT = 3080

  function log(msg) { try { if (api.log) api.log('[菜单扩展] ' + msg) } catch (e) {} }

  function ensureCss() {
    if (document.getElementById('dshpet-menu-extra-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-menu-extra-css'
    st.textContent = [
      // 「打开 dsh 网页端」那一行：做成一个被边框框住的按钮，和「偷吃白饭」同款
      '.dshpet-openweb-row{display:flex;align-items:center;gap:6px;margin:5px 0}',
      '.dshpet-openweb-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;' +
        'border:1px solid rgba(32,49,112,.5);border-radius:7px;background:rgba(32,49,112,.08);' +
        'color:#203170;font:12px/1.4 inherit;cursor:pointer;user-select:none;-webkit-user-select:none}',
      '.dshpet-openweb-btn:hover{background:rgba(32,49,112,.18)}',
      '.dshpet-openweb-btn:active{background:rgba(32,49,112,.28)}',
    ].join('')
    document.head.appendChild(st)
  }

  // --------------------------------------------------------------------------
  // ① 删掉「避让滚动条 + 宽度」那一整行
  // --------------------------------------------------------------------------
  // 定位方式：找那个 title 里带"避开滚动条"的复选框（元素没有专属 class）。
  function killScrollGapRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    var boxes = menu.querySelectorAll('input[type="checkbox"]')
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i]
      if (String(b.title || '').indexOf('避开滚动条') < 0) continue
      // 功能也一并关掉：菜单项没了，但配置里可能还留着"开"。
      // 默认值本来就是 false（贴边），这里把历史遗留的"开"纠正回来。
      if (b.checked) {
        b.checked = false
        try { b.dispatchEvent(new Event('change', { bubbles: true })) } catch (e) {}
        log('已把「避让滚动条」关掉（该项已从菜单移除）')
      }
      // 整行藏掉（父节点就是 .dshwv-menu-row）
      var row = b.closest ? b.closest('.dshwv-menu-row') : b.parentNode
      if (row) { row.style.display = 'none'; return true }
    }
    return false
  }

  // --------------------------------------------------------------------------
  // ② 加上「打开 dsh 网页端」
  // --------------------------------------------------------------------------
  // ⚠️ **端口不能写死。** dsh web 启动时会把访问地址打印出来，不同机器端口不同
  //    （官方文档："命令会打印其访问地址"；社区教程也说"不同电脑网址不同"）。
  //    3080 只是常见默认值 —— 实测这台机器上它根本没在监听，
  //    写死就会打开一个必然连不上的地址（用户看到的就是"打不开"）。
  //    所以这里交给主进程去**探测**（先试常见端口，再扫本机监听端口）。
  function injectOpenWebRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-openweb-row')) return true

    var row = document.createElement('div')
    row.className = 'dshpet-openweb-row'
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dshpet-openweb-btn'
    var LABEL = '🌐 打开 dsh 网页端'
    btn.textContent = LABEL
    btn.title = '用默认浏览器打开本机的 dsh web（端口自动探测）'
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      if (!api.openDshWeb) { log('主进程没有 openDshWeb 接口（preload 版本过旧？）'); return }
      btn.disabled = true
      // 主进程会：先找在跑的 → 找不到就**自己启动**（npx @deepseek-ai/dsh web，
      // 会弹一个 cmd 窗口）→ 再轮询等它起来（最多 90 秒）。
      // 所以这里要告诉用户"在找/在启动"，而不是干等着以为卡死了。
      btn.textContent = '⏳ 正在找 / 启动 dsh 网页端…'
      var restore = function () { btn.disabled = false; btn.textContent = LABEL }
      api.openDshWeb().then(function (r) {
        restore()
        if (r && r.ok) { log('已打开 ' + r.url); return }
        var why = r && r.reason
        if (why === 'timeout') {
          btn.textContent = '⚠ 启动超时，看 cmd 窗口的报错'
        } else if (why === 'spawn-failed') {
          btn.textContent = '⚠ 启动失败（可能没装 Node/npx）'
        } else {
          btn.textContent = '⚠ 没能打开 dsh 网页端'
        }
        log('打开 dsh 网页端失败：' + JSON.stringify(r))
        setTimeout(function () { btn.textContent = LABEL }, 5000)
      }).catch(function (err) {
        restore()
        btn.textContent = '⚠ 打开失败'
        log('打开失败: ' + (err && err.message))
        setTimeout(function () { btn.textContent = LABEL }, 5000)
      })
    })
    row.appendChild(btn)

    // 插在「偷吃白饭」后面；找不到就接在「拖动物理」后面；再找不到就放末尾
    var anchor = menu.querySelector('.dshpet-rice-row') ||
                 menu.querySelector('.dshpet-phys-row')
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(row, anchor.nextSibling)
    else menu.appendChild(row)
    return true
  }

  function tick() {
    var a = killScrollGapRow()
    var b = injectOpenWebRow()
    return a && b
  }

  function start() {
    ensureCss()
    // 菜单一出现就立刻注入，之后菜单重建也会自动补
    //（见 renderer/shell.js 的 __dshpetWatchRows 说明）
    if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(tick)
    else tick()
    log('菜单扩展已就绪')
  }

  window.__dshpetMenuExtras = {
    start: start,
    killScrollGapRow: killScrollGapRow,
    injectOpenWebRow: injectOpenWebRow,
    hintPort: DSH_WEB_HINT_PORT,
  }
})()
