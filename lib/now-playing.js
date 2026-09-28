// ============================================================================
// 「识别歌曲和作者」—— 读取正在播放的歌，并推给渲染进程弹气泡
// ============================================================================
// 数据来源：Windows 媒体会话（GSMTC），由 lib/gsmtc.ps1 常驻轮询。
// 为什么走 PowerShell 而不是纯 Node：GSMTC 是 WinRT 接口，Node 不能直接调，
// 而引一个原生模块（node-gyp 编译）会把这个"免安装单文件"的桌宠彻底搞复杂。
// 详见 lib/gsmtc.ps1 顶部那段说明。
//
// 这个模块只做四件事：
//   ① 把 gsmtc.ps1 落到数据目录并**常驻**跑起来（不是每次轮询起一个新进程）
//   ② 逐行解析它输出的 JSON
//   ③ 从所有媒体会话里挑出"正在播的那一首"（**任何音乐平台**，见 pickSong）
//   ④ 歌变了才通知上层（onUpdate），避免每 1.5 秒都弹一次
//
// ⚠️ 挑歌的逻辑（pickSong）刻意写成**纯函数**并导出：给一批会话，该挑出哪一首
//    这件事可以拿假数据测。自检里就是这么验的（见 main.cjs）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// —— 三个目标播放器 ——
// 判据是会话的 SourceAppUserModelId（AUMID）。它是"应用标识"，
// 桌面版通常是进程名（KuGou.exe / cloudmusic.exe / QQMusic.exe），
// 商店版则是包族名（形如 KugouMusic.KugouMusic_xxx!App）——
// 所以用**子串**匹配，而不是全等。
//
// ⚠️ 各家的 AUMID 会随版本变，这里多留几个别名；万一还是没匹配上，
//    pet.log 里会把"见过的所有 AUMID"记下来（见 logSeenApps），照着加一条即可。
export const PLAYERS = [
  { id: 'kugou', name: '酷狗音乐', keys: ['kugou', 'kugoumusic', 'kugou8'] },
  { id: 'netease', name: '网易云音乐', keys: ['cloudmusic', 'orpheus', 'netease', 'neteasecloudmusic'] },
  { id: 'qqmusic', name: 'QQ音乐', keys: ['qqmusic', 'qqmusicapp'] },
  // ⚠️ echo-music 不在用户点名的三家之内，是**实测发现**本机在装、
  //    而且正在播歌（GSMTC 里有 title/artist/album 且 Playing）才加上的。
  //    加它的理由：用户点名的三家这台机器上都没装，不加的话这个功能
  //    对他们**一次都不会触发**。多认一个播放器没有副作用（只按 AUMID 匹配），
  //    所以留着。要拿掉就删这一行。
  { id: 'echomusic', name: 'echo-music', keys: ['echomusic', 'hoowhoami'] },
]

// 这些"应用"永远不是我们要的音乐播放器，先排掉。
// （本机实测：浏览器和 B 站客户端也会注册媒体会话，标题是视频名、作者为空。）
const NOT_MUSIC = ['bilibili', 'slbrowser', 'chrome', 'msedge', 'firefox', 'potplayer', 'vlc']

function normApp(v) { return String(v || '').toLowerCase() }

// —— 给没进白名单的 AUMID 起个能看的名 ——
// 'com.bilibili.bilibiliPC' → 'bilibiliPC'；'KuGou.exe' → 'KuGou'；
// 商店版包族 'KugouMusic.KugouMusic_x!App' → 'KugouMusic.KugouMusic_x'。
// 只求"用户能对上是哪个软件"，不求好听。
function prettyApp(appId) {
  var s = String(appId || '').trim()
  if (!s) return '媒体播放器'
  if (s.indexOf('!') >= 0) s = s.split('!')[0]
  s = s.replace(/\.exe$/i, '')
  var segs = s.split(/[./\\]/).filter(Boolean)
  var last = segs[segs.length - 1] || s
  return last || '媒体播放器'
}

// 这些"应用"永远不是音乐播放器（浏览器/B站/视频播放器 —— 标题是视频名不是歌名）
export function isExcludedApp(appId) {
  const a = normApp(appId)
  if (!a) return false
  for (let i = 0; i < NOT_MUSIC.length; i++) {
    if (a.indexOf(NOT_MUSIC[i]) >= 0) return true
  }
  return false
}

export function matchPlayer(appId) {
  const a = normApp(appId)
  if (!a) return null
  if (isExcludedApp(appId)) return null
  for (let p = 0; p < PLAYERS.length; p++) {
    const pl = PLAYERS[p]
    for (let k = 0; k < pl.keys.length; k++) {
      if (a.indexOf(pl.keys[k]) >= 0) return pl
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 纯函数：从一批会话里挑出"现在该显示哪一首"
// ---------------------------------------------------------------------------
// 规则：
//   · 只认三个目标播放器（matchPlayer）
//   · 标题必须有（没标题就没什么可显示的）
//   · 正在播的优先；都在播（或都没有明确状态）时，按 PLAYERS 的顺序取第一个
//   · 全都不是"在播"就返回 null —— 暂停/停止不该弹新气泡
//
// status 是 GSMTC 的 PlaybackStatus：Playing / Paused / Stopped / Closed / Opened。
// ⚠️ 对**空/未知**状态刻意宽容：有些播放器某些版本不上报状态，
//    要是严格要求 === 'Playing'，功能会**静默失效**（比偶尔多弹一次糟得多）。
function isPlaying(s) {
  const st = String((s && s.status) || '').toLowerCase()
  if (!st) return true          // 不上报 → 当作在播
  if (st === 'playing') return true
  return false                  // paused / stopped / closed / opened
}

export function pickSong(sessions) {
  const list = Array.isArray(sessions) ? sessions : []
  const cands = []
  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {}
    // NOT_MUSIC（浏览器/B站/视频播放器）仍然排除 —— 它们的标题是
    // 视频名/网页名，不是歌名，拿来查歌词只会得到错的结果。
    if (isExcludedApp(s.app)) continue
    const pl = matchPlayer(s.app)
    const title = String(s.title || '').trim()
    if (!title) continue
    cands.push({
      // ⚠️ **任何音乐平台都接受**（用户需求："各个音乐平台都能识别"）。
      //    Windows 的系统媒体状态（GSMTC）对所有接入了媒体控件的播放器
      //    都给出歌名/歌手/进度 —— 白名单之外的一样有完整数据。
      //    已知播放器排前面；白名单外的用 prettyApp 起名。
      playerId: pl ? pl.id : ('app:' + normApp(s.app)),
      playerName: pl ? pl.name : prettyApp(s.app),
      app: String(s.app || ''),
      title,
      artist: String(s.artist || '').trim(),
      album: String(s.album || '').trim(),
      // 播放位置/总时长（秒）。歌词要"一句接一句"就靠它对齐时间轴。
      pos: isFinite(Number(s.pos)) ? Number(s.pos) : -1,
      // pos 是"posAt 那一刻"的快照（epoch ms）。渲染端靠它外推此刻的真实位置：
      //     livePos = pos + (Date.now() - posAt)/1000 * rate
      // 没有它的话只能"采样值 + 本地时钟猜"，永远差一截。
      posAt: isFinite(Number(s.posAt)) ? Number(s.posAt) : -1,
      rate: isFinite(Number(s.rate)) && Number(s.rate) > 0 ? Number(s.rate) : 1,
      dur: isFinite(Number(s.dur)) ? Number(s.dur) : -1,
      playing: isPlaying(s),
      order: pl ? PLAYERS.findIndex((p) => p.id === pl.id) : PLAYERS.length,
    })
  }
  const playing = cands.filter((c) => c.playing)
  // ⚠️⚠️ **暂停时也要把这首返回出去（playing:false）。**
  //    原来这里是 `playing.length ? playing : []` —— 暂停就返回 null，
  //    而渲染端收到 null 走的是"保持现状"分支（不清时钟），
  //    于是**本地时钟继续跑**，歌词越走越偏 ——
  //    用户报的"暂停后歌词还会往后显示一段时间"就是这个。
  //    现在把暂停中的那首也返回，渲染端就能知道"同一首歌，但停了"，
  //    从而立刻收起气泡并停掉时钟。
  const pool = playing.length ? playing : cands
  if (!pool.length) return null
  pool.sort((a, b) => a.order - b.order)
  const best = pool[0]
  delete best.order
  return best
}

// ---------------------------------------------------------------------------
export function createNowPlaying({ dataDir, rootDir, log, onUpdate, lyrics }) {
  const say = (m) => { try { if (log) log('[识别歌曲] ' + m) } catch (e) {} }
  const SCRIPT_SRC = path.join(rootDir, 'lib', 'gsmtc.ps1')
  const SCRIPT_DST = path.join(dataDir, 'gsmtc.ps1')

  let child = null
  let enabled = false
  let stopping = false
  let restarts = 0
  let ready = false
  let lastError = ''
  let lastSessions = []
  let current = null          // 当前"已通知过"的那一首
  let currentKey = ''         // 上面那首的唯一键，用来丢弃过期的歌词请求
  let buf = ''
  const seenApps = Object.create(null)

  // —— 歌词状态 ——
  let lyricsEnabled = false
  let lyricLines = []         // [{t, text}]
  let lyricsState = 'none'    // none | loading | ready | notfound

  function songKey(s) { return s ? (s.app + '\u0000' + s.title + '\u0000' + s.artist) : '' }

  // 组装推给渲染进程的载荷
  function payload() {
    if (!current) return null
    return {
      title: current.title,
      artist: current.artist,
      playerName: current.playerName,
      app: current.app,
      pos: current.pos,
      // 位置记录时刻 + 倍速 —— 渲染端用它外推"此刻"的真实位置
      posAt: current.posAt,
      rate: current.rate,
      dur: current.dur,
      // 是否正在播放 —— 渲染端据此"暂停就收起歌词气泡"
      playing: current.playing !== false,
      lyricsEnabled,
      lyricsState,
      // 歌词只在就绪时带出去（没就绪时是空数组，渲染进程据此显示"找歌词…"）
      lyrics: lyricsState === 'ready' ? lyricLines : [],
    }
  }

  function push() {
    try { if (onUpdate) onUpdate(payload()) } catch (e) {}
  }

  function resetLyrics(song) {
    lyricLines = []
    if (!song) { lyricsState = 'none'; return }
    if (!lyricsEnabled) { lyricsState = 'none'; return }
    if (!lyrics) { lyricsState = 'notfound'; return }
    lyricsState = 'loading'
    const myKey = songKey(song)
    const myTitle = song.title
    const myArtist = song.artist
    // 时长也带去：歌词源匹配候选时用它排除翻唱/ remix（时长差一大截的直接不要）
    const myDur = song.dur > 0 ? song.dur : undefined
    // 异步取；回来时先确认"歌还没换"，否则丢弃（不然会闪出上一首的歌词）
    lyrics.fetch(myTitle, myArtist, myDur).then((r) => {
      if (myKey !== currentKey) return
      lyricLines = (r && r.lines) || []
      lyricsState = lyricLines.length ? 'ready' : 'notfound'
      push()
    }).catch(() => {
      if (myKey !== currentKey) return
      lyricLines = []
      lyricsState = 'notfound'
      push()
    })
  }

  // 把脚本落到数据目录再执行。
  // ⚠️ 不能直接把 asar 里的路径交给 PowerShell —— asar 是虚拟文件系统，
  //    只有 Electron 的 fs 认得，powershell.exe 读不了。
  function materialize() {
    const src = fs.readFileSync(SCRIPT_SRC)
    let cur = null
    try { cur = fs.readFileSync(SCRIPT_DST) } catch (e) {}
    if (!cur || !cur.equals(src)) {
      fs.writeFileSync(SCRIPT_DST, src)
      say('已写出 gsmtc.ps1（' + src.length + ' 字节）')
    }
    return SCRIPT_DST
  }

  // 见过的 AUMID 记一遍就够了 —— 用户报"没识别到"时，这是唯一的线索
  function logSeenApps(sessions) {
    for (let i = 0; i < sessions.length; i++) {
      const a = String((sessions[i] && sessions[i].app) || '')
      if (!a || seenApps[a]) continue
      seenApps[a] = true
      const pl = matchPlayer(a)
      const excluded = isExcludedApp(a)
      say('发现媒体会话：' + a + (pl ? '  → 认作 ' + pl.name
        : excluded ? '  → 排除（不是音乐播放器）' : '  → 按通用播放器处理（标题照常识别）'))
    }
  }

  function handleLine(line) {
    const t = String(line || '').trim()
    if (!t) return
    let d = null
    try { d = JSON.parse(t) } catch (e) { return }
    if (!d) return
    if (d.ready) { ready = true; say('媒体会话接口已就绪'); return }
    if (d.ok === false) { lastError = String(d.reason || 'unknown'); say('轮询报错：' + lastError); return }
    // sessions 可能是数组、单对象、或 null（ConvertTo-Json 对单元素数组会退化成对象）
    let list = d.sessions
    if (!list) list = []
    else if (!Array.isArray(list)) list = [list]
    lastSessions = list
    logSeenApps(list)
    const song = pickSong(list)
    const key = songKey(song)
    const changed = key !== currentKey
    if (changed) {
      current = song
      currentKey = key
      if (song) say('识别到：' + song.title + ' — ' + (song.artist || '未知歌手') + '（' + song.playerName + '）')
      else say('当前没有在播的目标播放器')
      resetLyrics(song)
    } else if (song) {
      // 同一首歌：只更新进度（歌词靠它对齐时间轴）
      current.pos = song.pos
      current.posAt = song.posAt
      current.rate = song.rate
      current.dur = song.dur
      // playing 也要同步 —— 渲染端靠它决定"暂停就收起气泡"
      current.playing = song.playing
    }
    // 歌变了要推；开了歌词则**每拍都推**（渲染进程靠 pos 决定显示哪一句）
    if (changed || lyricsEnabled) push()
  }

  function spawnIt() {
    let exe = 'powershell.exe'
    try {
      const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      if (fs.existsSync(p)) exe = p
    } catch (e) {}
    let scriptPath = ''
    try { scriptPath = materialize() } catch (e) {
      lastError = 'materialize failed: ' + (e && e.message)
      say('写出 gsmtc.ps1 失败：' + lastError)
      return
    }
    try {
      child = spawn(exe, ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      lastError = 'spawn failed: ' + (e && e.message)
      say('启动 PowerShell 失败：' + lastError)
      child = null
      return
    }
    say('已启动媒体会话轮询（pid ' + (child.pid || '?') + '）')
    buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        handleLine(line)
      }
      if (buf.length > 65536) buf = ''    // 防御：万一来了一坨没有换行的东西
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      const s = String(d || '').trim()
      if (s) { lastError = s; say('PowerShell stderr：' + s.slice(0, 300)) }
    })
    child.on('error', (e) => { lastError = String(e && e.message); say('PowerShell 进程错误：' + lastError) })
    child.on('exit', (code) => {
      child = null
      ready = false
      if (stopping) return
      say('PowerShell 退出了（code ' + code + '）')
      // 退出了就重来一次 —— 但别无限重启刷屏
      if (restarts < 5) {
        restarts++
        setTimeout(() => { if (!stopping && enabled) spawnIt() }, 3000)
      } else {
        say('重启次数过多，停止重试（托盘 →「打开日志」可看原因）')
      }
    })
  }

  function killIt() {
    if (!child) return
    const c = child
    child = null
    try { c.kill() } catch (e) {}
  }

  return {
    start() { say('已就绪（默认关闭，菜单里打开才轮询）') },
    isEnabled() { return enabled },
    setEnabled(on) {
      on = !!on
      if (on === enabled) return enabled
      enabled = on
      if (on) {
        restarts = 0
        current = null
        currentKey = ''
        spawnIt()
      } else {
        killIt()
        ready = false
        lastSessions = []
        current = null
        currentKey = ''
        lyricLines = []
        lyricsState = 'none'
        // 关掉时也要把"歌词"一起关掉，否则下次打开会带着上一次的状态
        lyricsEnabled = false
        try { if (onUpdate) onUpdate(null) } catch (e) {}
      }
      say('识别歌曲 ' + (on ? '开' : '关'))
      return enabled
    },
    // —— 歌词开关 ——
    setLyricsEnabled(on) {
      on = !!on
      if (on === lyricsEnabled) return lyricsEnabled
      lyricsEnabled = on
      // 立刻按当前这首歌重新取/清歌词，不用等下一个 1.5 秒
      resetLyrics(current)
      if (current) push()
      say('识别歌词 ' + (on ? '开' : '关'))
      return lyricsEnabled
    },
    isLyricsEnabled() { return lyricsEnabled },
    stop() { stopping = true; killIt() },
    // —— 自检专用：往解析器里喂一行假数据 ——
    // 本机没装那三个播放器，所以"PowerShell → 解析 → 挑歌 → 推给渲染进程 → 弹气泡"
    // 这条完整链路没法靠真播放器验。喂一行**格式与 gsmtc.ps1 输出完全一致**的
    // 假数据，就能把整条链（含 IPC 和渲染）跑通。
    __testLine(line) { try { handleLine(line) } catch (e) { say('测试注入失败：' + (e && e.message)) } },
    // 排障/自检用
    status() {
      return {
        enabled, ready, lastError,
        childPid: child ? child.pid : null,
        sessions: lastSessions.map((s) => ({ app: s.app, title: s.title, artist: s.artist, status: s.status, pos: s.pos })),
        seenApps: Object.keys(seenApps),
        current: current ? { title: current.title, artist: current.artist, pos: current.pos, dur: current.dur } : null,
        lyricsEnabled, lyricsState, lyricCount: lyricLines.length,
      }
    },
  }
}

export { isPlaying, NOT_MUSIC }
