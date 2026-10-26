// ---------------------------------------------------------------------------
// elog.js —— 从网易云音乐运行日志（cloudmusic.elog）读实时播放进度
//
// 为什么需要它（2026-10-26）：
//   · Windows SMTC 拿不到网易云的时间轴 —— GetTimelineProperties() 恒为 0，
//     和酷狗一模一样（酷狗靠 MSAA 读界面，见 lib/gsmtc.ps1 里的 Get-MsaaProgress）；
//   · 但网易云自己会把「切歌 / 播放暂停 / **拖动进度条**」写进运行日志，
//     这是唯一能感知用户拖动的数据源 —— MSAA 读界面只能看到"现在几秒"，
//     看不出"用户刚跳到了哪里"。
//
// 日志格式（整篇编码过，需逐字节查表解码）：
//   [pid:tid:MMDD/HHMMSS:开机毫秒:LEVEL:file(line)] [日期] 【playing】,"事件名",参数…
//
// 解码算法与事件状态机移植自开源项目「小鲸鱼 Seeker 0.4.2」的
//   server/elog-reader.mjs（其解码表又移植自 netease-cloudmusic-detector-py，MIT）。
//
// 与上游的差异（只有三处，逻辑一律不动）：
//   ① 状态从模块级单例改成 createElogReader() 的闭包 —— 我们这边可能同时存在
//      多个实例（自检会另起一个），模块级单例互相污染；
//   ② 日志走注入的 log()，不写 console；
//   ③ 回溯上限 64MB → 16MB —— 主进程是 Electron，同步读 64MB 会把 UI 卡住
//      几百毫秒；网易云的 elog 一般在几百 KB ~ 几 MB，16MB 已经非常宽。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const POLL_MS = 1000
// 回溯上限：见文件头 ③
const BACKTRACK_CAP = 16 * 1024 * 1024
// 记录位置距文件尾超过这个值就不信它（太久没跑，中间可能切过歌）
const RESUME_MAX_GAP = 5 * 1024 * 1024
const OFFSET_SAVE_MS = 30000

// ── 解码表（逐字节变换，与上游完全一致）─────────────────────────
const DECODE_TABLE = (() => {
  const t = new Uint8Array(256)
  for (let b = 0; b < 256; b++) {
    const high = b >> 4
    const low = b & 0x0f
    const hexDigit = (high ^ ((low + 8) % 16)) % 16
    t[b] = (hexDigit * 16 + (b >> 6) * 4 + (~high & 3)) & 0xff
  }
  return t
})()

export function decodeElog(buf) {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = DECODE_TABLE[buf[i]]
  return out.toString('utf8')
}

// 逆表 —— 只有测试用（造一段假日志喂进去）。生产路径永远不会编码。
export function encodeElog(str) {
  const inv = new Uint8Array(256)
  const seen = new Uint8Array(256)
  for (let b = 0; b < 256; b++) {
    const v = DECODE_TABLE[b]
    if (seen[v]) return null          // 不是双射（理论上不会），测试会立刻发现
    seen[v] = 1
    inv[v] = b
  }
  const src = Buffer.from(String(str), 'utf8')
  const out = Buffer.allocUnsafe(src.length)
  for (let i = 0; i < src.length; i++) out[i] = inv[src[i]]
  return out
}

// ── 找日志 ──────────────────────────────────────────────────────
// 只试这两个路径（与上游一致）。装到非默认盘就找不到 —— 那时会标 degraded，
// 退回 SMTC（拿不到位置）或本地时钟，不会报错也不会卡住。
export function findElog() {
  const home = os.homedir()
  const candidates = [
    path.join(home, 'AppData', 'Local', 'Netease', 'CloudMusic', 'cloudmusic.elog'),
    path.join(home, 'AppData', 'Local', 'NetEase', 'CloudMusic', 'cloudmusic.elog'),
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch (e) {}
  }
  return ''
}

// ── 行解析用的正则 ──────────────────────────────────────────────
// [pid:tid:MMDD/HHMMSS:开机毫秒:LEVEL:...   → 取「开机毫秒」
const RE_REL = /^\s*\[[^\]]*:(\d+):[A-Z]+:/

// songId 的可信来源（与 handleText 保持一致）—— 刻意排除 checkPlayPrivilege：
//   它是「权限预检」，播放列表预取下一首时也会触发，当切歌信号会让 songId 提前跳走。
const RE_SONG_SOURCE = /"playOneTrackInPlayingList",\{"id":"\d+"|"playingSource",\{"playInfo":\{[^}]*"songId":"\d+"/

export function createElogReader(opts = {}) {
  const say = (m) => { try { if (opts.log) opts.log('[elog] ' + m) } catch (e) {} }
  const dataDir = opts.dataDir || ''
  const forcedPath = opts.elogPath || ''

  // 状态机：只存「基准位置 + 基准时刻」，查询时现算 —— 天然免疫轮询间隔。
  const state = {
    songId: '',
    durationMs: 0,
    playing: false,
    basePosMs: 0,      // 基准位置
    baseAtRelMs: 0,    // 基准时刻（开机毫秒）
    lastEventAt: 0,    // 最后一次解析到事件的墙钟时间
    parsedLines: 0,
    eventLines: 0,
    degraded: false,
  }

  let elogPath = ''
  let offset = 0
  let lastSize = 0
  let timer = null
  let started = false
  let parseErrorStreak = 0
  let offsetFilePath = ''
  let lastOffsetSaveAt = 0

  // 当前开机时长（毫秒）—— 与日志里的「开机毫秒」同一坐标系。
  // 用 uptime 而不是 Date.now()：不受 NTP 对时跳变影响，也不需要跟日志对时区。
  function uptimeMs() {
    return Math.round(os.uptime() * 1000)
  }

  function currentPosMs(nowRel) {
    if (!state.playing) return Math.max(0, state.basePosMs)
    return Math.max(0, state.basePosMs + (nowRel - state.baseAtRelMs))
  }

  // ── 解析一批解码后的文本，推进状态机 ────────────────────────
  function handleText(text) {
    const lines = text.split('\n')
    for (const raw of lines) {
      if (!raw) continue
      state.parsedLines++
      if (raw.indexOf('【playing】') < 0) continue

      const m = raw.match(RE_REL)
      if (!m) { parseErrorStreak++; continue }
      const rel = Number(m[1])
      if (!Number.isFinite(rel) || rel <= 0) { parseErrorStreak++; continue }

      state.eventLines++
      parseErrorStreak = 0
      state.lastEventAt = Date.now()

      // 1) 切歌 —— songId 有三个来源，任意一个出现就更新。
      //    ⚠ 只用 playOneTrackInPlayingList 会漏：从本地文件 / 直接点某首歌 /
      //      纯音乐切过去时不产生这个事件，songId 会卡在上一首，歌词一直显示别人的。
      //    ⚠ 但也**不能**把 checkPlayPrivilege 当切歌信号：播放列表会预取下一首的
      //      权限与歌词，日志里会出现下一首的 id（A→B→A 回跳），songId 被提前切走。
      //      所以它只用来取 duration，不改 songId。
      let newSongId = ''
      const track = raw.match(/"playOneTrackInPlayingList",\{"id":"(\d+)"/)
      if (track) newSongId = track[1]
      if (!newSongId) {
        const src = raw.match(/"playingSource",\{"playInfo":\{[^}]*"songId":"(\d+)"/) ||
                    raw.match(/"native播放资源(?:开始load|load完成[^"]*)",\{[^}]*"songId":"(\d+)"/)
        if (src) newSongId = src[1]
      }
      if (!newSongId && !state.songId) {
        // 兜底：songId 为空时（首次启动、或续读窗口里没有可信切歌事件）才允许用它初始化。
        const priv = raw.match(/"checkPlayPrivilege",\{"id":"(\d+)"/)
        if (priv) newSongId = priv[1]
      }
      if (newSongId) {
        if (newSongId !== state.songId) {
          state.songId = newSongId
          state.basePosMs = 0
          state.baseAtRelMs = rel
          // 换歌必须重置时长 —— 有些切歌方式（playingSource）不带 duration，
          // 不清就会一直沿用上一首的时长，导致进度被错误截断。
          state.durationMs = 0
          // 新歌未开始播前先标记为暂停，等 native播放state 纠正
          state.playing = false
        }
        // 注意：不 continue —— 同一行往往还带 duration，交给下面继续解析
      }

      // 2) 时长（checkPlayPrivilege / playInfo 里都带 duration）
      const dur = raw.match(/"duration":(\d+)/)
      if (dur) {
        const d = Number(dur[1])
        if (d > 1000 && d < 3600000) state.durationMs = d
      }

      // 3) 播放状态：1=播放中 2=暂停
      const st2 = raw.match(/"native播放state",(\d)/)
      if (st2) {
        const v = Number(st2[1])
        if (v === 1 && !state.playing) {
          state.playing = true
          state.baseAtRelMs = rel
        } else if (v === 2 && state.playing) {
          state.basePosMs = currentPosMs(rel)
          state.playing = false
        }
        continue
      }

      // 4) 拖动 / 跳转：参数为秒 —— 这条就是 SMTC 永远给不了的东西
      const sp = raw.match(/"setPlayingPosition",(\d+)/)
      if (sp) {
        state.basePosMs = Number(sp[1]) * 1000
        state.baseAtRelMs = rel
        continue
      }

      // 5) 暂停事件
      if (/"pause",/.test(raw)) {
        if (state.playing) {
          state.basePosMs = currentPosMs(rel)
          state.playing = false
        }
        continue
      }

      // 6) 开始播放
      if (/"setPlaying",/.test(raw)) {
        if (!state.playing) {
          state.playing = true
          state.baseAtRelMs = rel
        }
      }
    }

    // 连续解析失败过多 → 标记降级（格式可能变了）
    if (parseErrorStreak > 50) state.degraded = true
  }

  // ── 增量读取 ────────────────────────────────────────────────
  function readRange(fd, start, end) {
    const len = end - start
    if (len <= 0) return null
    const buf = Buffer.allocUnsafe(len)
    let got = 0
    try {
      got = fs.readSync(fd, buf, 0, len, start)
    } catch (e) {
      return null
    }
    return got > 0 ? buf.subarray(0, got) : null
  }

  /**
   * 轻量扫描：这段文本里是否「最后一次歌源事件之后、且在 【playing】 行上，还有 duration」。
   * 三个条件必须同时满足（少一个就会判定通过、解析却拿不到）：
   *   ① 有歌源事件 —— 否则不知道该从哪首歌开始看
   *   ② duration 必须在最后一个歌源事件**之后** —— 否则那是上一首的时长
   *   ③ duration 必须在该行的 【playing】 里 —— handleText 只处理 playing 行
   */
  function hasTrackEvent(text) {
    const lines = text.split('\n')

    let songLine = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (l.indexOf('【playing】') < 0) continue
      if (RE_SONG_SOURCE.test(l)) { songLine = i; break }
    }
    if (songLine < 0) return false

    for (let i = songLine; i < lines.length; i++) {
      const l = lines[i]
      if (l.indexOf('【playing】') < 0) continue
      if (/"duration":\d{4,}/.test(l)) return true
    }
    return false
  }

  /**
   * 动态回溯：从文件尾往前找「最近一次切歌事件（且其后带 duration）」所在的起点。
   *
   * 回溯窗口 = min(文件大小 × 75%, 16MB)
   *   按比例走：日志越大看得越远；硬上限防内存爆掉（读进来的是完整字节块）。
   *
   * 做法：从尾部每次回退 1MB，先做轻量正则扫描；一旦命中就从该点完整解析到文件尾
   *   （能顺带恢复 duration / 播放状态 / 位置基准）。找不到返回 -1（宁可不显示）。
   * 开销：只在「首次启动」和「日志被截断」时执行一次，不是轮询。
   */
  function findBacktrackStart(fd, size) {
    const STEP = 1024 * 1024
    const maxBacktrack = Math.min(Math.floor(size * 0.75), BACKTRACK_CAP)
    let end = size
    let scanned = 0

    while (end > 0 && scanned < maxBacktrack) {
      const start = Math.max(0, end - STEP)
      const buf = readRange(fd, start, end)
      if (buf) {
        if (hasTrackEvent(decodeElog(buf))) {
          say('回溯命中切歌事件，起点=' + start + '（回溯 ' + Math.round((size - start) / 1024) + ' KB）')
          return start
        }
        scanned += buf.length
      }
      end = start
    }

    say('回溯 ' + Math.round(scanned / 1024 / 1024) + ' MB 未找到切歌事件，放弃')
    return -1
  }

  // ── 读取位置的持久化 ────────────────────────────────────────
  // 目的：重启后从上次的位置继续读，避免每次都回溯扫描日志。
  //   · 写盘失败 / 文件损坏 → 静默忽略，走回溯兜底
  //   · 日志被截断、或记录位置离尾部太远 → 记录作废，也走回溯
  function loadOffsetRecord() {
    if (!offsetFilePath) return null
    try {
      if (!fs.existsSync(offsetFilePath)) return null
      const j = JSON.parse(fs.readFileSync(offsetFilePath, 'utf8'))
      if (!j || typeof j.offset !== 'number' || typeof j.size !== 'number') return null
      return j
    } catch (e) {
      return null
    }
  }

  function saveOffsetRecord(force) {
    if (!offsetFilePath) return
    const now = Date.now()
    if (!force && (now - lastOffsetSaveAt) < OFFSET_SAVE_MS) return
    lastOffsetSaveAt = now
    try {
      fs.writeFileSync(offsetFilePath, JSON.stringify({
        offset: offset,
        size: lastSize,
        songId: state.songId || '',
        // 位置状态也要存 —— 只存 offset 的话，续读窗口里通常**没有切歌事件**，
        // songId 会是空、basePos/baseAt 都是 0，位置就会被算成"整个开机时长"。
        // （上游 Seeker 存了 songId 但没恢复，这里补上。）
        basePosMs: state.basePosMs,
        baseAtRelMs: state.baseAtRelMs,
        playing: state.playing,
        durationMs: state.durationMs,
        savedAt: now,
      }), 'utf8')
    } catch (e) {
      // 写盘失败不影响主流程
    }
  }

  function readNew() {
    let st
    try { st = fs.statSync(elogPath) } catch (e) {
      return   // 日志不存在
    }

    if (st.size < lastSize) {
      // 日志被截断 / 滚动 → 重置偏移，下次从尾部重新回溯
      say('日志变小，重置: ' + lastSize + ' → ' + st.size + '（重置前 songId=' + state.songId + '）')
      offset = 0
      lastSize = 0
    }

    if (st.size === offset) return   // 无新增

    let start = offset
    let isBacktrack = false

    // 首次（offset=0）：优先从「上次记录的读取位置」续读，避免每次重启都回溯。
    if (offset === 0) {
      const saved = loadOffsetRecord()
      let resumed = false
      if (saved) {
        // 保险一：日志比记录的小 → 被网易云截断过，记录作废
        // 保险二：记录位置距离文件尾 > 5MB → 太久没跑，中间可能切过歌，记录不可信
        const gap = st.size - saved.offset
        if (saved.offset > 0 && saved.offset <= st.size && st.size >= saved.size && gap <= RESUME_MAX_GAP) {
          start = saved.offset
          resumed = true
          // 恢复位置状态 —— 续读窗口里往往没有切歌事件，光靠 handleText 填不出
          // songId 和基准，位置会被算成"整个开机时长"（几十万秒）。
          if (saved.songId) state.songId = String(saved.songId)
          if (typeof saved.durationMs === 'number') state.durationMs = saved.durationMs
          if (typeof saved.basePosMs === 'number') state.basePosMs = saved.basePosMs
          if (typeof saved.baseAtRelMs === 'number') state.baseAtRelMs = saved.baseAtRelMs
          if (typeof saved.playing === 'boolean') state.playing = saved.playing
          say('续读上次位置 offset=' + saved.offset + '（距尾部 ' + Math.round(gap / 1024) +
            ' KB，songId=' + (state.songId || '?') + ' pos=' + Math.round(state.basePosMs / 1000) + 's）')
        } else {
          say('记录不可用（gap=' + Math.round(gap / 1024) + ' KB），改走回溯')
        }
      }

      if (!resumed) {
        let fd0
        try { fd0 = fs.openSync(elogPath, 'r') } catch (e) { return }
        try {
          start = findBacktrackStart(fd0, st.size)
        } finally {
          try { fs.closeSync(fd0) } catch (e) {}
        }
        if (start < 0) {
          // 回溯失败：仍从某个位置读，但标记降级（避免反复回溯刷日志）
          start = Math.max(0, st.size - 1024 * 1024)
          state.degraded = true
        } else {
          isBacktrack = true
        }
      }
    }

    const len = st.size - start
    if (len <= 0) { offset = st.size; lastSize = st.size; return }

    let buf
    try {
      buf = Buffer.allocUnsafe(len)
      const fd = fs.openSync(elogPath, 'r')
      try {
        fs.readSync(fd, buf, 0, len, start)
      } finally {
        fs.closeSync(fd)
      }
    } catch (e) {
      return
    }

    offset = st.size
    lastSize = st.size

    const prevSong = state.songId
    try {
      handleText(decodeElog(buf))
    } catch (e) {
      // 解码异常不应中断轮询
    }
    saveOffsetRecord()
    if (state.songId !== prevSong) {
      say('songId ' + (prevSong || '(空)') + ' → ' + state.songId +
        '  playing=' + state.playing + '  dur=' + state.durationMs +
        (isBacktrack ? ' [回溯]' : ''))
    }
  }

  // 日志路径必须**真的存在**才算有效。
  // findElog() 内部已经做过存在性检查，但 forcedPath（自检注入的假日志）
  // 可能还没创建 —— 所以这里统一再确认一次。
  function probePath() {
    const p = forcedPath || findElog()
    if (!p) return ''
    try { return fs.existsSync(p) ? p : '' } catch (e) { return '' }
  }

  // 每个 tick 先确保"日志存在"，再读新增部分。
  // 为什么要每 tick 检查：用户很可能**先开桌宠、后开网易云**（或者桌宠开机自启，
  // 人过一会儿才点开播放器）。只在 start() 里找一次的话，那次找不到就永久放弃了。
  // fs.existsSync 很轻，1 秒一次没有可感开销。
  function tick() {
    if (!elogPath) {
      elogPath = probePath()
      if (!elogPath) return
      say('找到日志: ' + elogPath)
    }
    readNew()
  }

  // ── 对外 ────────────────────────────────────────────────────
  return {
    /**
     * 启动轮询。
     * 返回值 = **此刻**是否已经找到日志；找不到也照样启动轮询，
     * 之后每秒再看一眼（用户可能晚点才开网易云）。
     */
    start() {
      if (started) return !!elogPath
      started = true
      if (dataDir) {
        try { offsetFilePath = path.join(dataDir, 'elog-offset.json') } catch (e) { offsetFilePath = '' }
      }
      elogPath = probePath()
      if (elogPath) say('已启动，日志: ' + elogPath)
      else say('暂未找到 cloudmusic.elog（没装网易云 / 还没启动），每秒重试一次')
      // 首次读放到下一轮事件循环 —— 回溯扫描是同步 fs，别卡住启动
      setImmediate(() => { try { tick() } catch (e) {} })
      timer = setInterval(() => { try { tick() } catch (e) {} }, POLL_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
      return !!elogPath
    },

    stop() {
      if (timer) { clearInterval(timer); timer = null }
      try { saveOffsetRecord(true) } catch (e) {}
      started = false
    },

    isStarted() { return started },

    location() { return elogPath },

    /**
     * 每次调用**现算**位置（状态机里存的是「基准位置 + 基准时刻」）。
     * ok=false 表示日志没找到；degraded=true 表示日志格式可能变了。
     */
    snapshot() {
      const nowRel = uptimeMs()
      const pos = currentPosMs(nowRel)
      const duration = state.durationMs
      const stale = state.lastEventAt > 0 && (Date.now() - state.lastEventAt) > 5 * 60 * 1000
      return {
        ok: !!elogPath,
        source: 'elog',
        songId: state.songId,
        positionMs: duration > 0 ? Math.min(pos, duration) : pos,
        durationMs: duration,
        playing: state.playing,
        updatedAt: state.lastEventAt || 0,
        degraded: state.degraded,
        stale,
        stats: { parsedLines: state.parsedLines, eventLines: state.eventLines },
      }
    },

    // 自检/排障：直接喂文本（跳过文件读取），用来验状态机
    __feed(text) { try { handleText(String(text || '')) } catch (e) {} },
  }
}
