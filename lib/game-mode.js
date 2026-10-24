// ============================================================================
// 游戏模式（移植自上游 whale-pet-desktop 0.4.2 的 server.mjs 游戏段）
// ============================================================================
// 三层职责：
//   ① 游戏识别 —— 检测链：自定义名单 → 启动器进程树 → 名单检测（Windows
//      游戏列表 / 内置白名单 / N 卡索引）→ 前台窗口兜底（严格全屏）。
//      粘性运行：识别到游戏后只要进程还在就保持在玩；交叉判断缓存（exe→
//      是否游戏）持久化，误判一次可纠正并记住。
//   ② 光标状态采样 —— lib/cursor-state.ps1 常驻进程（Win32 GetCursorInfo），
//      FPS 里游戏隐藏光标但位置仍随视角移动 → 悬停隐藏据此暂停，防误触发。
//      （上游用 koffi 独立 node 插件；我们沿用 gsmtc.ps1 的常驻 PS 模式，
//        免掉原生依赖。）
//   ③ 设置持久化 —— mode（off/hover/always）、防误触开关、自定义名单。
//
// 状态通过 onState 推给主进程；主进程负责显隐（本模块不碰窗口）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0 }

const GAME_LAUNCHERS = ['steam.exe', 'epicgameslauncher.exe', 'battle.net.exe', 'wegame.exe', 'ubisoftconnect.exe', 'upc.exe', 'galaxyclient.exe']
const GAME_HELPERS = ['steamwebhelper.exe', 'steamservice.exe', 'gameoverlayui.exe', 'epicwebhelper.exe', 'crashpad_handler.exe', 'crashreporter.exe', 'battle.net helper.exe', 'agent.exe', 'wegamehelper.exe', 'steamerrorreporter.exe']
const GAME_BLACKLIST = ['browser.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'iexplore.exe', 'opera.exe', 'brave.exe',
  'explorer.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'node.exe', 'python.exe', 'pythonw.exe', 'java.exe',
  'steamwebhelper.exe', 'epicwebhelper.exe', 'crashpad_handler.exe', 'crashreporter.exe', 'agent.exe',
  'battle.net helper.exe', 'wegamehelper.exe', 'steamservice.exe', 'gameoverlayui.exe', 'steamerrorreporter.exe',
  'searchindexer.exe', 'dllhost.exe', 'rundll32.exe', 'conhost.exe', 'svchost.exe',
  'wegameclient.exe', 'wegametray.exe', 'wegameplatform.exe', 'wegameservice.exe',
  'upc.exe', 'uplay.exe', 'ubisoftconnect.exe', 'ubisoftconnectservice.exe',
  'uplaywebcore.exe', 'ubisoftgamelauncher.exe',
  'nvidia overlay.exe', 'nvsphelper.exe', 'nvspcaps.exe', 'nvcontainer.exe', 'nvidia app.exe',
  'obs64.exe', 'obs.exe', 'streamlabs.exe', 'bandicam.exe',
  'wps.exe', 'wpsoffice.exe', 'wpp.exe', 'et.exe', 'wpspdf.exe', 'wpscloudsvr.exe', 'wpsofficeupdate.exe',
  'wpscenter.exe', 'ksolaunch.exe', 'wpscli.exe', 'wpscloudlaunch.exe', 'wpslingxi.exe', 'ksoxmled.exe',
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'onenote.exe', 'outlook.exe',
  'foxitreader.exe', 'foxitpdfreader.exe', 'acrobat.exe', 'acrord32.exe',
  'typora.exe', 'obsidian.exe', 'notion.exe', 'dingtalk.exe', 'feishu.exe', 'wxwork.exe', 'wemeetapp.exe',
  'baidunetdiskunite.exe', 'baidunetdisk.exe', 'thunder.exe', 'xldl.exe', 'qqdownloader.exe',
  'potplayermini64.exe', 'potplayermini.exe', 'vlc.exe', 'mpc-hc64.exe', 'mpc-be64.exe',
  'wegamehelper.exe', 'tgpdaemon.exe', 'tgpclient.exe', 'tencentdl.exe', 'tenio.exe', 'qyclient.exe']
const GAME_KNOWN_EXES = new Set([
  'rail.exe', 'cs2.exe', 'csgo.exe', 'dota2.exe', 'league of legends.exe', 'valorant.exe', 'valorant-win64-shipping.exe',
  'genshinimpact.exe', 'starrail.exe', 'pubg.exe', 'tslgame.exe', 'deltaforceclient-win64-shipping.exe',
  'narakabladepoint.exe', 'thedivision2.exe', 'thedivision.exe', 'cyberpunk2077.exe', 'gta5.exe', 'gta5_enhanced.exe',
  'r5apex.exe', 'r5apex_dx12.exe', 'eldenring.exe', 'sekiro.exe', 'darksoulsiii.exe', 'monsterhunterworld.exe',
  'monsterhunterrise.exe', 'residentevil4.exe', 're4.exe', 'hogwartslegacy.exe', 'alanwake2.exe', 'starfield.exe',
  'bg3.exe', 'bg3_dx11.exe', 'palworld.exe', 'palworld-win64-shipping.exe', 'helldivers2.exe', 'overwatch.exe',
  'overwatch2.exe', 'worldofwarships.exe', 'wows.exe', 'warframe.exe', 'warframe.x64.exe', 'pathofexile.exe',
  'pathofexile_x64.exe', 'diabloiv.exe', 'diablo iii.exe', 'world of warcraft.exe', 'wow.exe', 'hearthstone.exe',
  'starcraft ii.exe', 'starcraft.exe', 'minecraft.exe', 'terraria.exe', 'stardew valley.exe', 'hollow_knight.exe',
  'celeste.exe', 'hades.exe', 'hades2.exe', 'cuphead.exe', 'the witcher3.exe', 'witcher3.exe', 'fallout4.exe',
  'fallout76.exe', 'skyrimse.exe', 'skyrim.exe', 'titanfall2.exe', 'bf1.exe', 'bf2042.exe', 'bfv.exe', 'cod.exe',
  'modernwarfare.exe', 'rainbowsix.exe', 'rainbowsixsiege.exe', 'for honor.exe', 'division2.exe', 'eurotrucks2.exe',
  'americantrucksimulator.exe', 'starcitizen.exe', 'wuthering waves.exe', 'client-win64-shipping.exe', 'nikke.exe',
  'lostark.exe', 'new world.exe', 'valheim.exe', 'rust.exe', 'dayz.exe', 'pubg: battlegrounds.exe',
])
// 前台窗口兜底的黑名单（全屏误伤面更大的那批：办公/会议/浏览器/录屏/播放器/桌宠）
const HW_BLACK_EXTRA = ['electron.exe', 'workbuddy.exe', 'dsh.exe', 'deepseek.exe', 'claude.exe',
  'explorer.exe', 'qq.exe', 'msedge.exe', 'chrome.exe', 'firefox.exe', 'gamepp.exe', 'xiaomipcmanager.exe',
  'nvidiacontainer.exe', 'nvidia share.exe', 'nvdisplay.container.exe', 'nvidia overlay.exe',
  'nvsphelper.exe', 'nvspcaps.exe', 'nvcontainer.exe', 'nvidia app.exe', 'nvidiaapp.exe',
  'obs64.exe', 'obs.exe', 'streamlabs.exe', 'bandicam.exe',
  'wps.exe', 'wpsoffice.exe', 'wpp.exe', 'et.exe', 'wpspdf.exe', 'wpscloudsvr.exe', 'wpsofficeupdate.exe',
  'wpscenter.exe', 'ksolaunch.exe', 'wpscli.exe', 'wpscloudlaunch.exe', 'wpslingxi.exe', 'ksoxmled.exe',
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'onenote.exe', 'outlook.exe', 'mspub.exe', 'msaccess.exe',
  'foxitreader.exe', 'foxitpdfreader.exe', 'foxitphantompdf.exe', 'acrobat.exe', 'acrord32.exe',
  'typora.exe', 'obsidian.exe', 'notion.exe', 'sublime_text.exe', 'notepad++.exe',
  'dingtalk.exe', 'feishu.exe', 'lark.exe', 'wxwork.exe', 'wemeetapp.exe', 'zoom.exe', 'teams.exe',
  'baidunetdiskunite.exe', 'baidunetdisk.exe', 'thunder.exe', 'xldl.exe', 'qqdownloader.exe',
  'potplayermini64.exe', 'potplayermini.exe', 'vlc.exe', 'mpc-hc64.exe', 'mpc-be64.exe',
  'mismartsharehandoff.exe', 'textinputhost.exe',
  'bongo cat mver.exe', 'bongo cat.exe', 'desktop pet.exe', 'wallpaper engine.exe', 'wallpaperengine.exe',
  'cloudmusic.exe', 'qqmusic.exe', 'kugou.exe', 'kuwo.exe', 'foobar2000.exe', 'spotify.exe',
  // 我们自己：绝不能把桌宠宿主判成游戏
  '大肥鱼桌宠.exe', 'electron.exe', 'dafatfish-pet.exe']

export function createGameMode({ dataDir, rootDir, log = () => {}, onState = () => {} }) {
  const say = (m) => { try { log('[游戏模式] ' + m) } catch (err) {} }
  const readJson = (p, dft) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (err) { return dft } }
  const writeJson = (p, o) => { try { fs.writeFileSync(p, JSON.stringify(o), 'utf8') } catch (err) {} }

  const GAMES_FILE = path.join(dataDir, '.dshwv-game.json')
  const VERDICTS_FILE = path.join(dataDir, '.dshwv-game-verdicts.json')
  const GAME_NAMES_FILE = path.join(dataDir, '.dshwv-game-names.json')
  const PROBE_SRC = path.join(rootDir, 'lib', 'game-probe.ps1')
  const WINGAMES_SRC = path.join(rootDir, 'lib', 'win-games.ps1')
  const CURSOR_SRC = path.join(rootDir, 'lib', 'cursor-state.ps1')
  const PROBE_DST = path.join(dataDir, 'game-probe.ps1')
  const WINGAMES_DST = path.join(dataDir, 'win-games.ps1')
  const CURSOR_DST = path.join(dataDir, 'cursor-state.ps1')
  // PS 脚本落数据目录再执行（asar 是虚拟文件系统，PowerShell 读不了）
  for (const [s, d] of [[PROBE_SRC, PROBE_DST], [WINGAMES_SRC, WINGAMES_DST], [CURSOR_SRC, CURSOR_DST]]) {
    try { fs.copyFileSync(s, d) } catch (err) { say('脚本落盘失败: ' + (err && err.message)) }
  }

  let setting = Object.assign({ mode: 'hover', antiMistouch: true, list: [] }, readJson(GAMES_FILE, {}))
  if (!Array.isArray(setting.list)) setting.list = []
  if (['off', 'hover', 'always'].indexOf(setting.mode) < 0) setting.mode = 'hover'
  setting.antiMistouch = setting.antiMistouch !== false

  let state = { ok: true, running: false, exe: '', name: '', source: '', since: 0, stoppedAt: 0 }
  let lastProcs = []
  let stickyGame = null
  let winGames = new Set()
  let winGamesAt = 0
  let verdicts = readJson(VERDICTS_FILE, {})
  let nvGameMap = null
  let nvGameMapAt = 0
  let pollAt = 0
  let polling = false
  let probeChild = null
  let cursorChild = null
  let cursorBuf = ''
  let cursor = { fresh: false, visible: true, x: 0, y: 0, at: 0 }
  let started = false
  let stopFlag = false
  let pollTimer = null
  let cursorWatchdog = null

  // —— 推给主进程的载荷（带设置，主进程不再回读） ——
  function payload() {
    return Object.assign({}, state, { mode: setting.mode, antiMistouch: setting.antiMistouch })
  }
  function emitState() { try { onState(payload()) } catch (err) {} }

  function getSettings() {
    return { mode: setting.mode, antiMistouch: setting.antiMistouch, list: setting.list, state: payload() }
  }
  function setSettings(patch) {
    try {
      if (patch && ['off', 'hover', 'always'].indexOf(patch.mode) >= 0) setting.mode = patch.mode
      if (patch && typeof patch.antiMistouch === 'boolean') setting.antiMistouch = patch.antiMistouch
      if (patch && Array.isArray(patch.list)) {
        setting.list = patch.list.slice(0, 200).map((x) => ({
          exe: gameNorm(x && x.exe),
          name: String((x && x.name) || ''),
          enabled: (x && x.enabled === false) ? false : true,
        })).filter((x) => x.exe)
      }
      writeJson(GAMES_FILE, setting)
      applyCursorLifecycle()
      emitState()
      say('设置已保存: mode=' + setting.mode + ' 防误触=' + setting.antiMistouch)
      return getSettings()
    } catch (err) { return { ok: false, error: String((err && err.message) || err) } }
  }

  // —— 光标状态采样（常驻 PS，stdout 每行一个 JSON）——
  function startCursorSampler() {
    if (cursorChild) return
    try {
      cursorChild = spawn('powershell', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', CURSOR_DST],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      cursorChild.on('error', () => { cursorChild = null })
      cursorChild.on('exit', () => { cursorChild = null })
      if (cursorChild.stdout) {
        cursorChild.stdout.on('data', (b) => {
          cursorBuf += String(b)
          let i
          while ((i = cursorBuf.indexOf('\n')) >= 0) {
            const line = cursorBuf.slice(0, i).trim()
            cursorBuf = cursorBuf.slice(i + 1)
            try {
              const j = JSON.parse(line)
              if (j && j.ok) cursor = { fresh: true, visible: !!j.visible, x: num(j.x), y: num(j.y), at: Date.now() }
            } catch (err) {}
          }
        })
      }
      say('光标采样已启动')
    } catch (err) { say('光标采样启动失败: ' + (err && err.message)); cursorChild = null }
  }
  function stopCursorSampler() {
    try { if (cursorChild) { cursorChild.kill(); cursorChild = null } } catch (err) {}
    cursor = { fresh: false, visible: true, x: 0, y: 0, at: 0 }
  }
  function applyCursorLifecycle() {
    // 防误触开（且模式不是 off）才需要光标采样
    if (setting.antiMistouch && setting.mode !== 'off') { if (started) startCursorSampler() }
    else stopCursorSampler()
  }
  // 掉线自动补起（5s 复查一次）
  function cursorWatchdogTick() {
    try {
      if (!started || stopFlag) return
      const want = setting.antiMistouch && setting.mode !== 'off'
      if (want && !cursorChild) startCursorSampler()
    } catch (err) {}
  }

  // —— Windows 游戏列表（Xbox Game Bar / 游戏模式记录；5 分钟缓存）——
  function loadWinGames() {
    const now = Date.now()
    if (now - winGamesAt < 5 * 60 * 1000) return
    winGamesAt = now
    try {
      const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINGAMES_DST], { windowsHide: true })
      let buf = ''
      if (ps.stdout) ps.stdout.on('data', (c) => { buf += c })
      ps.on('close', () => {
        try {
          const arr = JSON.parse(buf || '[]')
          if (Array.isArray(arr)) { winGames = new Set(arr.map((x) => String(x).toLowerCase())) }
        } catch (err) {}
      })
      ps.on('error', () => {})
    } catch (err) {}
  }

  // —— N 卡索引（NVIDIA App ApplicationStorage.json → exe→游戏名，5 分钟缓存）——
  function nvGameName(exe) {
    try {
      const now = Date.now()
      if (nvGameMap && (now - nvGameMapAt) < 5 * 60 * 1000) return nvGameMap[String(exe || '').toLowerCase()] || ''
      nvGameMapAt = now
      const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
      const fp = path.join(base, 'NVIDIA Corporation', 'NVIDIA app', 'NvBackend', 'ApplicationStorage.json')
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      const map = {}
      const apps = Array.isArray(j && j.Applications) ? j.Applications : []
      for (const a of apps) {
        const app = a && a.Application
        const name = app && app.DisplayName
        if (!name) continue
        if (/nvidia|geforce/i.test(name)) continue
        const files = Array.isArray(app.DetectedFiles) ? app.DetectedFiles : []
        for (const f of files) {
          const s = String(f || '')
          if (!/\.exe$/i.test(s)) continue
          const base2 = s.replace(/\\/g, '/').split('/').pop()
          if (base2) map[base2.toLowerCase()] = name
        }
        const lc = String(app.LaunchCmd || '')
        const lm = lc.match(/([^\\/]+\.exe)/i)
        if (lm) map[lm[1].toLowerCase()] = name
      }
      nvGameMap = map
      // 沉淀到本地名表（只增不改，用户可手改）
      try {
        const cur = readJson(GAME_NAMES_FILE, {}) || {}
        let changed = false
        for (const k of Object.keys(map)) {
          const nm = String(map[k] || '').trim()
          if (!nm) continue
          const base3 = k.replace(/\.exe$/i, '')
          if (!cur[base3]) { cur[base3] = nm; changed = true }
        }
        if (changed) writeJson(GAME_NAMES_FILE, cur)
      } catch (err) {}
      return map[String(exe || '').toLowerCase()] || ''
    } catch (err) { return '' }
  }

  function verdict(exe) { return verdicts[String(exe || '').toLowerCase()] || null }
  function setVerdict(exe, isGame, name, src) {
    try {
      verdicts[String(exe || '').toLowerCase()] = { isGame: !!isGame, name: String(name || ''), at: Date.now(), src: String(src || '') }
      const keys = Object.keys(verdicts)
      if (keys.length > 2000) {
        keys.sort((a, b) => (verdicts[b].at || 0) - (verdicts[a].at || 0))
        for (let i = 2000; i < keys.length; i++) delete verdicts[keys[i]]
      }
      writeJson(VERDICTS_FILE, verdicts)
    } catch (err) {}
  }
  function gameNorm(s) { return String(s || '').trim().toLowerCase().replace(/^.*[\\/]/, '') }
  function gameLabel(exe) { return String(exe || '').replace(/\.exe$/i, '') }
  function gameCleanTitle(t) {
    let s = String(t || '').trim()
    if (!s) return ''
    s = s.replace(/\s*[-–—|｜]\s*(DirectX|DX11|DX12|Vulkan|Steam|Windows|64-bit|32-bit|兼容模式).*$/i, '')
    s = s.replace(/\s*\(C\)\s*\d{4}.*$/i, '')
    s = s.replace(/\s*\(C\).*$/i, '')
    s = s.replace(/\s*[-–—|｜]\s*$/, '').trim()
    if (!s) return ''
    if (/^[\w.\- ]+$/.test(s) && s.length <= 24) {
      if (s.toLowerCase().replace(/\.exe$/, '') === s.toLowerCase()) return ''
    }
    if (s.length > 32) s = s.slice(0, 32)
    return s
  }
  function gameSetRunning(running, exe, name, source) {
    if (running) {
      if (!state.running || state.exe !== exe || (name && state.name !== name)) {
        state = { ok: true, running: true, exe: exe || '', name: name || '', source: source || '', since: Date.now(), stoppedAt: 0 }
        say('检测到游戏: ' + (name || exe) + ' [' + source + ']')
        emitState()
      }
    } else if (state.running) {
      state = { ok: true, running: false, exe: state.exe, name: state.name, source: state.source, since: 0, stoppedAt: Date.now() }
      say('游戏结束: ' + (state.name || state.exe))
      emitState()
    }
  }

  // —— 探针 + 检测链（节流 2500ms；每轮 spawn 一次 PS）——
  function refresh() {
    const now = Date.now()
    if (polling || (now - pollAt) < 2500) return state
    pollAt = now; polling = true
    let child
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE_DST], { windowsHide: true })
    } catch (err) { polling = false; return state }
    probeChild = child
    let out = ''
    child.stdout.on('data', (b) => { out += String(b); if (out.length > 4 * 1024 * 1024) { try { child.kill() } catch (e) {} } })
    child.on('error', () => { polling = false; probeChild = null })
    child.on('exit', () => {
      polling = false; probeChild = null
      try {
        let arr = JSON.parse(out || '[]')
        if (!Array.isArray(arr)) arr = [arr]
        const procs = arr.map((p) => ({
          pid: num(p.ProcessId), ppid: num(p.ParentProcessId),
          exe: gameNorm(p.Name), title: String(p.Title || ''), handle: Number(p.Handle || 0), isFg: !!p.IsFg,
          winW: num(p.WinW), winH: num(p.WinH), winX: num(p.WinX), winY: num(p.WinY),
          created: (function (cd) {
            const s = String(cd || '')
            const m = s.match(/[\/]Date\(([0-9]+)\)[\/]/)
            return m ? Number(m[1]) : (Date.parse(s) || 0)
          })(p.CreationDate),
        })).filter((p) => p.exe && p.pid)
        lastProcs = procs
        const scrW = num(arr.find((x) => x && x.ScrW)?.ScrW) || 1920
        const scrH = num(arr.find((x) => x && x.ScrH)?.ScrH) || 1080
        const byExe = new Set(procs.map((p) => p.exe))
        // 粘性游戏：上一轮识别到的游戏只要进程还在就保持在玩（切屏/窗口化不误判中止）
        if (stickyGame && byExe.has(stickyGame.exe)) {
          const sp = procs.find((p) => p.exe === stickyGame.exe)
          gameSetRunning(true, stickyGame.exe, stickyGame.name, 'window')
          if (sp) stickyGame = { exe: stickyGame.exe, name: stickyGame.name }
          return
        }
        if (stickyGame && !byExe.has(stickyGame.exe)) stickyGame = null
        // ① 自定义名单
        for (const it of setting.list) {
          if (!it || it.enabled === false) continue
          const exe = gameNorm(it.exe)
          if (exe && byExe.has(exe)) { gameSetRunning(true, exe, String(it.name || gameLabel(exe)), 'custom'); return }
        }
        // ② 启动器进程树（Steam/Epic/WeGame/UBI/Battle.net/GOG）
        const launchers = procs.filter((p) => GAME_LAUNCHERS.indexOf(p.exe) >= 0)
        if (launchers.length) {
          const kids = new Map()
          for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p) }
          const seen = new Set(); const cands = []
          const walk = (pid, depth) => {
            if (depth > 4) return
            for (const c of (kids.get(pid) || [])) {
              if (seen.has(c.pid)) continue
              seen.add(c.pid)
              if (GAME_HELPERS.indexOf(c.exe) >= 0 || GAME_LAUNCHERS.indexOf(c.exe) >= 0) continue
              if (GAME_BLACKLIST.indexOf(c.exe) >= 0) { walk(c.pid, depth + 1); continue }
              cands.push(c)
              walk(c.pid, depth + 1)
            }
          }
          for (const l of launchers) walk(l.pid, 0)
          const game = cands.filter((c) => c.created > 0 && c.handle > 0).sort((a, b) => b.created - a.created)[0]
          if (game) {
            const lnm = gameCleanTitle(game.title) || nvGameName(game.exe) || gameLabel(game.exe)
            stickyGame = { exe: game.exe, name: lnm }
            gameSetRunning(true, game.exe, lnm, 'launcher'); return
          }
        }
        // ③ 名单检测：Windows 游戏列表 → 内置白名单 → N 卡索引（要求有可见窗口）
        {
          const NV_SELF = ['electron.exe', 'workbuddy.exe', 'dsh.exe', 'deepseek.exe', 'claude.exe', 'wpsoffice.exe', 'wps.exe', 'livehime.exe', 'bilibili.exe', '大肥鱼桌宠.exe']
          const nvCands = procs.filter((c) => {
            if (!(c.handle > 0 && NV_SELF.indexOf(c.exe) < 0 && GAME_BLACKLIST.indexOf(c.exe) < 0)) return false
            const v = verdict(c.exe)
            if (v && v.isGame === false) return false
            if (v && v.isGame === true) return true
            return !!((winGames.has(c.exe) || GAME_KNOWN_EXES.has(c.exe) || nvGameName(c.exe)))
          }).sort((a, b) => b.created - a.created)
          if (nvCands.length) {
            const w = nvCands[0]
            const nm = gameCleanTitle(w.title) || nvGameName(w.exe) || gameLabel(w.exe)
            stickyGame = { exe: w.exe, name: nm }
            const src = winGames.has(w.exe) ? 'winlist' : (GAME_KNOWN_EXES.has(w.exe) ? 'whitelist' : 'nvindex')
            setVerdict(w.exe, true, nm, src)
            gameSetRunning(true, w.exe, nm, src)
            return
          }
        }
        // ④ 前台窗口兜底：N 卡索引 / Windows 游戏列表 / 严格全屏（尺寸≈屏且贴边）
        {
          const HW_BLACK = GAME_BLACKLIST.concat(HW_BLACK_EXTRA)
          const fg = procs.filter((c) => c.isFg && c.handle > 0 && HW_BLACK.indexOf(c.exe) < 0 && GAME_HELPERS.indexOf(c.exe) < 0 && GAME_LAUNCHERS.indexOf(c.exe) < 0)
          if (fg.length) {
            const w = fg[0]
            const v = verdict(w.exe)
            if (v && v.isGame === false) { /* 历史记过非游戏 → 不认 */ }
            else {
              const nvName = nvGameName(w.exe)
              const inWinList = winGames.has(w.exe)
              const exactlyFull = Math.abs(w.winW - scrW) <= 8 && Math.abs(w.winH - scrH) <= 8 && w.winX <= 8 && w.winY <= 8
              if (inWinList || nvName || exactlyFull || (v && v.isGame === true)) {
                const nm = gameCleanTitle(w.title) || nvName || gameLabel(w.exe)
                stickyGame = { exe: w.exe, name: nm }
                if (inWinList) setVerdict(w.exe, true, nm, 'winlist')
                gameSetRunning(true, w.exe, nm, inWinList ? 'winlist' : 'window')
                return
              }
            }
          }
        }
        gameSetRunning(false)
      } catch (err) { /* 解析失败维持上次状态 */ }
    })
    return state
  }

  function getProcs() {
    const SYS = ['system', 'registry', 'memory compression', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe',
      'lsass.exe', 'svchost.exe', 'fontdrvhost.exe', 'dwm.exe', 'conhost.exe', 'dllhost.exe', 'rundll32.exe',
      'searchindexer.exe', 'sihost.exe', 'ctfmon.exe', 'taskhostw.exe', 'node.exe', 'electron.exe']
    const uniq = {}
    for (const x of lastProcs) if (x && x.exe && SYS.indexOf(x.exe) < 0) uniq[x.exe] = 1
    return { ok: true, list: Object.keys(uniq).sort().slice(0, 300) }
  }
  function cursorState() { return cursor }

  function start() {
    if (started) return
    started = true
    stopFlag = false
    loadWinGames()
    pollTimer = setInterval(() => { try { if (!stopFlag) refresh() } catch (err) {} }, 3000)
    setInterval(() => { try { loadWinGames() } catch (err) {} }, 60000)
    cursorWatchdog = setInterval(cursorWatchdogTick, 5000)
    applyCursorLifecycle()
    say('已启动（mode=' + setting.mode + ' 防误触=' + setting.antiMistouch + '）')
  }
  function stop() {
    stopFlag = true
    try { if (pollTimer) clearInterval(pollTimer); pollTimer = null } catch (err) {}
    try { if (cursorWatchdog) clearInterval(cursorWatchdog); cursorWatchdog = null } catch (err) {}
    stopCursorSampler()
    try { if (probeChild) probeChild.kill() } catch (err) {}
    started = false
  }

  return { start, stop, refresh, getState: () => payload(), getSettings, setSettings, getProcs, cursorState, nvRefresh: () => { nvGameMap = null; nvGameMapAt = 0; nvGameName('') } }
}
