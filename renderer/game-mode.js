// ============================================================================
// 游戏模式 · 渲染端（移植自上游 whale-pet-desktop 0.4.2 的 goat-ui.js 游戏段）
// ============================================================================
// 三件事：
//   ① 游戏提示气泡 —— 开始/结束游戏的那一刻，把 4 行（标题/游戏名/进程/状态）
//      排队推入挂件自己的系统泡泡链路（window.__whaleSysPush，由宿主下发
//      widget.js 时注入的桥）。推不进（气泡位被音乐/消耗占着）就等，FIFO。
//   ② 立绘屏幕矩形上报 —— 每 500ms 一次，主进程的悬停隐藏按它判断光标
//      是否落在小鲸鱼上。
//   ③ 游戏隐藏期间的穿透闸 —— 主进程把窗口藏起来（透明+穿透）时，渲染端
//      的交互判定必须跟着让路（否则隐形的她会吞点击，历史大坑）。
//   ④ 菜单设置行 —— 游戏模式开关/模式选择/防误触开关 + 当前状态。
// ⚠️ 自检模式整个模块不干活。
(function () {
  'use strict'
  var api = window.petApi || {}
  if (api.selftest) return

  function log(m) { try { if (api.log) api.log('[游戏模式] ' + m) } catch (e) {} }

  // ==========================================================================
  // ① 游戏提示气泡（排队推挂件系统泡泡，与上游 goat-ui 同一套手法）
  // ==========================================================================
  // 进程名 → 中文游戏名（内置高频表；上游 GC249/GC274/GC316/GC331/GC334）
  var GAME_NAME_MAP = {
    'rail.exe': '逆战',
    'tgame.exe': '逆战',
    'cs2.exe': 'CS2', 'csgo.exe': 'CS:GO',
    'dota2.exe': 'Dota 2',
    'league of legends.exe': '英雄联盟',
    'valorant.exe': '无畏契约', 'valorant-win64-shipping.exe': '无畏契约',
    'genshinimpact.exe': '原神',
    'starrail.exe': '崩坏：星穹铁道',
    'pubg.exe': 'PUBG', 'tslgame.exe': 'PUBG',
    'deltaforceclient-win64-shipping.exe': '三角洲行动',
    'narakabladepoint.exe': '永劫无间',
    'thedivision2.exe': '全境封锁2', 'thedivision.exe': '全境封锁',
    'pgr.exe': '战双帕弥什',
    'cyberpunk2077.exe': '赛博朋克2077',
    'gta5.exe': 'GTA5', 'gta5_enhanced.exe': 'GTA5 增强版',
    'r5apex.exe': 'Apex 英雄', 'r5apex_dx12.exe': 'Apex 英雄',
    'eldenring.exe': '艾尔登法环',
    'sekiro.exe': '只狼：影逝二度',
    'darksoulsiii.exe': '黑暗之魂3',
    'monsterhunterworld.exe': '怪物猎人：世界',
    'monsterhunterrise.exe': '怪物猎人：崛起',
    'residentevil4.exe': '生化危机4 重制版', 're4.exe': '生化危机4 重制版',
    'hogwartslegacy.exe': '霍格沃茨之遗',
    'alanwake2.exe': '心灵杀手2',
    'starfield.exe': '星空',
    'bg3.exe': '博德之门3', 'bg3_dx11.exe': '博德之门3',
    'palworld.exe': '幻兽帕鲁', 'palworld-win64-shipping.exe': '幻兽帕鲁',
    'helldivers2.exe': '绝地潜兵2',
    'overwatch.exe': '守望先锋', 'overwatch2.exe': '守望先锋2',
    'worldofwarships.exe': '战舰世界', 'wows.exe': '战舰世界',
    'warframe.exe': '星际战甲', 'warframe.x64.exe': '星际战甲',
    'pathofexile.exe': '流放之路', 'pathofexile_x64.exe': '流放之路',
    'diabloiv.exe': '暗黑破坏神4', 'diablo iii.exe': '暗黑破坏神3',
    'world of warcraft.exe': '魔兽世界', 'wow.exe': '魔兽世界',
    'hearthstone.exe': '炉石传说',
    'starcraft ii.exe': '星际争霸2', 'starcraft.exe': '星际争霸',
    'minecraft.exe': '我的世界', 'javaw.exe': '我的世界(Java)',
    'terraria.exe': '泰拉瑞亚',
    'stardew valley.exe': '星露谷物语',
    'hollow_knight.exe': '空洞骑士',
    'celeste.exe': '蔚蓝',
    'hades.exe': '哈迪斯', 'hades2.exe': '哈迪斯2',
    'cuphead.exe': '茶杯头',
    'the witcher3.exe': '巫师3', 'witcher3.exe': '巫师3',
    'fallout4.exe': '辐射4', 'fallout76.exe': '辐射76',
    'skyrimse.exe': '上古卷轴5 天际', 'skyrim.exe': '上古卷轴5',
    'titanfall2.exe': '泰坦陨落2',
    'bf1.exe': '战地1', 'bf2042.exe': '战地2042', 'bfv.exe': '战地5',
    'cod.exe': '使命召唤', 'modernwarfare.exe': '使命召唤：现代战争',
    'rainbowsix.exe': '彩虹六号：围攻', 'rainbowsixsiege.exe': '彩虹六号：围攻',
    'for honor.exe': '荣耀战魂',
    'division2.exe': '全境封锁2',
    'eurotrucks2.exe': '欧洲卡车模拟2',
    'americantrucksimulator.exe': '美国卡车模拟',
    'starcitizen.exe': '星际公民',
    'wuthering waves.exe': '鸣潮',
    'genshin.exe': '原神',
    'nikke.exe': '胜利女神：妮姬',
    'lostark.exe': '失落的方舟',
    'new world.exe': '新世界',
    'valheim.exe': '英灵神殿',
    'rust.exe': '腐蚀',
    'dayz.exe': 'DayZ',
    'pubg: battlegrounds.exe': '绝地求生',
  }

  var toastQueue = []
  var toastTimer = null
  var toastBusy = false
  // 提示行配色（跟随上游默认模板色）
  var TPL_COLORS = ['#4a5b8f', '#203170', '#3d4f86']

  function showGameToast(title, name, state, exe) {
    try {
      toastBusy = true
      toastQueue.push({ title: String(title || ''), name: String(name || ''), state: String(state || ''), exe: String(exe || ''), tries: 0 })
      if (toastQueue.length > 5) toastQueue.shift()
      pumpGameToast()
    } catch (e) {}
  }

  function pumpGameToast() {
    try {
      if (toastTimer) return
      var item = toastQueue[0]
      if (!item) return
      var push = window.__whaleSysPush
      if (typeof push !== 'function') { retryLater(item); return }
      var ok = false
      try {
        // 字号：游戏名上限 12、进程名上限 8、标题按长度自适应（长名不换行）
        var nm = item.name || '—'
        var nameSize = 12
        var len = String(nm).length
        if (len > 8) nameSize = 10
        if (len > 12) nameSize = 8
        if (len > 16) nameSize = 6
        var titleSize = 6
        var tLen = String(item.title || '').length
        if (tLen > 6) titleSize = 5
        if (tLen > 9) titleSize = 4
        if (tLen > 12) titleSize = 3
        var mods = [
          { type: 'text', text: item.title, size: titleSize, bold: true, color: TPL_COLORS[0] },
          { type: 'text', text: nm, size: nameSize, bold: true, color: TPL_COLORS[1], rgb: 'indigo' },
          { type: 'text', text: item.state, size: 2, bold: true, color: TPL_COLORS[2] },
        ]
        if (item.exe && item.exe !== item.name) {
          var exeSize = Math.min(nameSize, 8)
          var exeLen = String(item.exe).length
          if (exeLen > 10) exeSize = Math.min(exeSize, 7)
          if (exeLen > 14) exeSize = Math.min(exeSize, 6)
          if (exeLen > 18) exeSize = Math.min(exeSize, 5)
          if (exeLen > 24) exeSize = Math.min(exeSize, 4)
          if (exeLen > 30) exeSize = 3
          mods.splice(2, 0, { type: 'text', text: item.exe, size: exeSize, bold: true, color: TPL_COLORS[1], rgb: 'indigo' })
        }
        ok = !!push({ kind: 'alert', rank: 1, ttlMs: 6500, mods: mods })
      } catch (e) { ok = false }
      item.tries++
      if (ok) {
        toastQueue.shift()
        toastBusy = true
        tightenToastRows(item)
        toastTimer = setTimeout(function () {
          toastBusy = toastQueue.length > 0
          toastTimer = null
          pumpGameToast()
        }, 6700)
        return
      }
      retryLater(item)
    } catch (e) { toastTimer = null }
  }
  function retryLater(item) {
    item.tries++
    if (item.tries >= 40) {
      toastQueue.shift()
      toastTimer = setTimeout(function () { toastTimer = null; pumpGameToast() }, 200)
      return
    }
    toastTimer = setTimeout(function () { toastTimer = null; pumpGameToast() }, 500)
  }
  // 行距收紧：游戏名↔进程名紧贴（对齐音乐气泡的「曲名↔译名」），单行自适应缩放。
  // inline 样式会被挂件重排丢掉 → 200/600/1200/2000ms 多次重压。
  function tightenToastRows(item) {
    var pass = function () {
      try {
        var pop = document.querySelector('.dshwv-pop')
        if (!pop) return
        var rows = pop.querySelectorAll('.dshwv-text .dshwv-trow')
        var nm = String(item.name || '').trim()
        var ex = String(item.exe || '').trim()
        var st = String(item.state || '').trim()
        var tt = String(item.title || '').trim()
        for (var i = 0; i < rows.length; i++) {
          var tx = String(rows[i].textContent || '').trim()
          if (tt && tx === tt) {
            rows[i].style.setProperty('line-height', '1.32', 'important')
            rows[i].style.setProperty('margin-top', '0.55em', 'important')
            rows[i].style.setProperty('margin-bottom', '5px', 'important')
            rows[i].style.setProperty('white-space', 'nowrap', 'important')
            shrinkToFit(rows[i])
          } else if (nm && tx === nm) {
            rows[i].style.setProperty('margin-top', '-0.23em', 'important')
            rows[i].style.setProperty('margin-bottom', '0px', 'important')
            rows[i].style.setProperty('line-height', '1.26', 'important')
          } else if (ex && tx === ex) {
            rows[i].style.setProperty('margin-top', '-0.18em', 'important')
            rows[i].style.setProperty('margin-bottom', '0.21em', 'important')
            rows[i].style.setProperty('line-height', '1.22', 'important')
            rows[i].style.setProperty('white-space', 'nowrap', 'important')
            shrinkToFit(rows[i])
          } else if (st && tx === st) {
            rows[i].style.setProperty('line-height', '1.24', 'important')
          }
        }
      } catch (e) {}
    }
    setTimeout(pass, 200)
    setTimeout(pass, 600)
    setTimeout(pass, 1200)
    setTimeout(pass, 2000)
  }
  function shrinkToFit(row) {
    try {
      var box = row.parentNode
      var maxW = box ? box.clientWidth : 0
      for (var k = 0; k < 12; k++) {
        if (!(maxW > 0 && row.scrollWidth > maxW)) break
        var fs = parseFloat(getComputedStyle(row).fontSize) || 12
        row.style.setProperty('font-size', (fs * 0.88) + 'px', 'important')
      }
    } catch (e) {}
  }

  if (api.onGameToast) {
    api.onGameToast(function (d) {
      try {
        var exeKey = String(d.exe || '').toLowerCase()
        var exeOnly = String(d.exe || '').replace(/\.exe$/i, '')
        // 取名优先级：内置中文表 → 主进程给的名字（窗口标题/N 卡/本地名表）→ exe 名
        var nm = GAME_NAME_MAP[exeKey] || String(d.name || '') || exeOnly || '—'
        if (d.running) showGameToast('老大你又在打电动喔', nm, '已启动', exeOnly)
        else setTimeout(function () { showGameToast('游戏时间结束', nm, '已终止', exeOnly) }, 1200)
      } catch (e) {}
    })
  }

  // ==========================================================================
  // ② 立绘屏幕矩形上报（悬停隐藏的命中判定用）
  // ==========================================================================
  setInterval(function () {
    try {
      var img = document.querySelector('img.dshwv-img')
      if (!img) return
      var r = img.getBoundingClientRect()
      if (!r || r.width <= 0) return
      if (api.reportWhaleRect) {
        api.reportWhaleRect({
          x: Math.round(r.left + (window.screenX || 0)),
          y: Math.round(r.top + (window.screenY || 0)),
          right: Math.round(r.right + (window.screenX || 0)),
          bottom: Math.round(r.bottom + (window.screenY || 0)),
        })
      }
    } catch (e) {}
  }, 500)

  // ==========================================================================
  // ③ 游戏隐藏期间的穿透闸（与 shell.js 的托盘隐藏闸同一语义）
  // ==========================================================================
  if (api.onGameHidden) {
    api.onGameHidden(function (on) {
      try {
        window.__dshpetGameHidden = !!on
        if (on && !window.__dshpetDragging) {
          if (api.setInteractive) api.setInteractive(false)
        }
        log('游戏隐藏 → ' + (on ? '穿透闸合上' : '放开'))
      } catch (e) {}
    })
  }

  // ==========================================================================
  // ④ 菜单设置行：🎮 游戏模式（状态 / 模式选择 / 防误触开关）
  // ==========================================================================
  var setting = null
  function applySettingRow() {
    try {
      var statusEl = document.getElementById('dshpet-gm-status')
      var sel = document.getElementById('dshpet-gm-mode')
      var cb = document.getElementById('dshpet-gm-anti')
      if (!statusEl || !sel || !cb) return
      var st = (setting && setting.state) || {}
      var running = !!st.running
      var nm = running ? String(st.name || st.exe || '') : ''
      statusEl.textContent = running ? ('游戏中：' + nm) : '未在游戏'
      if (setting) {
        if (sel.value !== String(setting.mode)) sel.value = String(setting.mode)
        if (cb.checked !== !!setting.antiMistouch) cb.checked = !!setting.antiMistouch
      }
    } catch (e) {}
  }
  function injectRow() {
    try {
      var menu = document.querySelector('.dshwv-menu')
      if (!menu) return false
      if (menu.querySelector('.dshpet-gm-row')) { applySettingRow(); return true }
      // 行 1：入口 + 状态
      var row = document.createElement('div')
      row.className = 'dshwv-menu-row dshpet-gm-row'
      var lab = document.createElement('span')
      lab.textContent = '🎮 游戏模式'
      row.appendChild(lab)
      var status = document.createElement('span')
      status.id = 'dshpet-gm-status'
      status.style.cssText = 'margin-left:auto;color:#536ba9;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px'
      status.textContent = '未在游戏'
      row.appendChild(status)
      // 行 2：模式选择
      var row2 = document.createElement('div')
      row2.className = 'dshwv-menu-row dshpet-gm-row'
      var lab2 = document.createElement('span')
      lab2.textContent = '游戏时'
      row2.appendChild(lab2)
      var sel = document.createElement('select')
      sel.id = 'dshpet-gm-mode'
      sel.title = '游戏时的行为：不做任何事 / 鼠标移到小鲸鱼上自动隐藏并穿透 / 进入游戏即隐藏'
      var opts = [['off', '不做任何事'], ['hover', '悬停隐藏（防误触）'], ['always', '启动即隐']]
      for (var i = 0; i < opts.length; i++) {
        var o = document.createElement('option')
        o.value = opts[i][0]
        o.textContent = opts[i][1]
        sel.appendChild(o)
      }
      sel.style.cssText = 'margin-left:auto;max-width:150px'
      sel.addEventListener('change', function (ev) {
        ev.stopPropagation()
        saveSetting({ mode: sel.value })
      })
      sel.addEventListener('click', function (ev) { ev.stopPropagation() })
      row2.appendChild(sel)
      // 行 3：防误触开关（悬停隐藏 + 光标检测）
      var row3 = document.createElement('div')
      row3.className = 'dshwv-menu-row dshpet-gm-row'
      var cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.id = 'dshpet-gm-anti'
      cb.style.cssText = 'accent-color:#2f4488'
      cb.addEventListener('change', function (ev) {
        ev.stopPropagation()
        saveSetting({ antiMistouch: cb.checked })
      })
      cb.addEventListener('click', function (ev) { ev.stopPropagation() })
      row3.appendChild(cb)
      var lab3 = document.createElement('span')
      lab3.textContent = '游戏防误触'
      lab3.title = '游戏运行时鼠标移到小鲸鱼上自动隐藏并穿透；FPS 里光标被游戏隐藏时自动暂停（隐藏防误触）。注意：开启后个别游戏会导致悬停隐藏失效'
      row3.appendChild(lab3)
      // 插到「小鲸鱼记账」行前面
      var anchor = null
      var rows = menu.querySelectorAll('.dshwv-menu-row')
      for (var j = 0; j < rows.length; j++) {
        if ((rows[j].textContent || '').indexOf('小鲸鱼记账') >= 0) { anchor = rows[j]; break }
      }
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(row, anchor)
        anchor.parentNode.insertBefore(row2, anchor)
        anchor.parentNode.insertBefore(row3, anchor)
      } else {
        menu.appendChild(row); menu.appendChild(row2); menu.appendChild(row3)
      }
      applySettingRow()
      return true
    } catch (e) { return false }
  }
  function saveSetting(patch) {
    try {
      if (!api.gameSet) return
      api.gameSet(patch).then(function (r) {
        if (r && r.state !== undefined) { setting = r; applySettingRow() }
        log('设置已保存 ' + JSON.stringify(patch))
      }).catch(function () {})
    } catch (e) {}
  }
  function loadSetting() {
    try {
      if (!api.gameGet) return
      api.gameGet().then(function (r) {
        if (r) { setting = r; applySettingRow() }
      }).catch(function () {})
    } catch (e) {}
  }

  function start() {
    loadSetting()
    // 菜单一出现就注入；之后菜单重建也会自动补（shell.js 的行观察器）
    if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(injectRow)
    else injectRow()
    // 定期刷新状态行（她开菜单时能看到实时的"游戏中：xxx"）
    setInterval(function () { try { if (document.querySelector('.dshpet-gm-row')) loadSetting() } catch (e) {} }, 4000)
    log('已就绪')
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
