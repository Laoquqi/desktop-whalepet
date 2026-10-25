// ============================================================================
// 歌词：搜索 + 取 LRC + 解析
// ============================================================================
// 音源：**多源 fallback**，按顺序试，谁先出结果用谁。
//
// ⚠️⚠️ **为什么必须多源**（2026-09-28 实测）：
//   之前只有 QQ 音乐一个源。QQ 的搜索接口
//   `c.y.qq.com/soso/fcgi-bin/client_search_cp` 现在**稳定返回 HTTP 500**
//   （0 字节 / 5 秒超时），于是**不管用户在哪个平台放歌，都识别不到歌词** ——
//   这正是"所有音乐平台都无法识别"的真正原因。
//   单点依赖就是这个下场：源一挂，功能全废。
//
// 各源实测（2026-09-28，同一台机器）：
//   · **酷狗** ✅✅ 三步全通，**匹配最准**（搜「晴天 周杰伦」第一条就是原唱）：
//       搜索  https://mobilecdn.kugou.com/api/v3/search/song   → hash
//       定位  https://krcs.kugou.com/search                    → id + accesskey
//       取词  https://lyrics.kugou.com/download                → base64 的 LRC
//       实测拿到 3488 字节的 base64，解码是标准 LRC（[ti:][ar:][00:02.25]…）。
//   · **QQ音乐** ⚠️ 接口结构没问题，但当前 500，保留着等它恢复。
//   · **网易云** ❌ 两步都通，但会**给出错歌词**（搜「晴天 周杰伦」挑中翻唱
//       「晴天 - Jay」；「青花瓷」拿到「纯音乐，请欣赏」占位行）——
//       根因是 pickBest 里"歌名完全一致"直接给满分、不看歌手，
//       而网易云排序又差。**故意不放进链里**（代码保留）。
//
// 顺序：**酷狗 → QQ**。每家都有超时（PROVIDER_TIMEOUT_MS），
// 一家卡住不会拖死整条链；全失败就老实显示"没找到歌词"，
// 而不是拿一个空字符串假装成功。
//
// 为什么需要时间轴（LRC）：用户要的是"一句接一句"。
//   GSMTC 给了当前播放位置（pos），拿 LRC 的时间轴一比，
//   就知道此刻该显示哪一句 —— 这才是跟着音乐走的歌词，
//   而不是把整首歌一次性倒出来。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const QQ_REFERER = 'https://y.qq.com/portal/player.html'
const NETEASE_REFERER = 'https://music.163.com/'
// 每家源单独限时：一家卡住不能拖死整条链。
// 3.5s 是实测留的余量（酷狗三步加起来 ~0.5s，QQ 挂的时候 5s 才超时）。
const PROVIDER_TIMEOUT_MS = 3500

function logWith(log) {
  return (m) => { try { if (log) log('[歌词] ' + m) } catch (e) {} }
}

// —— 文本归一化：比较歌名/歌手时用 ——
// 全角转半角、去掉括号里的补充说明（"(Live)"、"(remix)"、"（正式版）"…）、
// 去掉空白和常见分隔符，最后转小写。
function normName(s) {
  let t = String(s || '')
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  t = t.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ' ')
  t = t.replace(/[\s\-_·・.,，。!！?？'"“”‘’&+]/g, '')
  return t.toLowerCase()
}

// ---------------------------------------------------------------------------
// LRC 解析
// ---------------------------------------------------------------------------
// 支持：一行多个时间标签（[00:01.00][00:05.00]词）、[mm:ss]、[mm:ss.xx]、[mm:ss.xxx]。
// 跳过元数据标签（[ti:] [ar:] [al:] [by:] [offset:] …）—— 它们没有数字时间轴。
//
// ⚠️⚠️ **制作人员行过滤**（2026-09-28 用户实测）：
//   很多 LRC 的开头 30 秒是「作词 : xxx」「作曲 : xxx」这种**带时间戳的
//   制作人员行**（[00:00.000]作词 : 方文山 [00:15.000]作曲 : 周杰伦）——
//   它们带数字时间轴，会被当成歌词解析进 lines。于是歌曲前 30 秒
//   lineAt(pos) 返回的全是制作人员行，气泡里"作词/作曲"一句句闪 ——
//   用户看到的正是"只有作词作曲在闪烁，歌词显示不出来"。
//   过滤规则（零误伤设计）：**制作人员关键词后面紧跟冒号**（作词 : / 作曲：）
//   才过滤；真正的歌词几乎不可能以「作词 : 」开头。空格分隔的形式
//   （「作词 方文山」）只对强关键词启用。制作人员行也可能出现在 LRC
//   末尾，所以**全曲过滤**，不只过滤开头。
var CREDIT_COLON_RE = /^\s*(作词|作曲|编曲|混音|混缩|母带|监制|制作|和声|和音|配唱|填词|原曲|原词|歌词|发行|出品|出品人|录音|混录|封面|统筹|企划|吉他|贝斯|鼓|键盘|弦乐| OP| SP| ED|Lyrics|Lyricist|Composer|Arranger|Arrangement|Mixing|Mixed|Mastering|Producer|Produced)\s*[:：]/
var CREDIT_SPACE_RE = /^\s*(作词|作曲|编曲|混音|混缩|母带|监制|和声|和音|配唱|填词|原曲|原词|发行|出品|制作|录音|混录|统筹)\s+\S/
function isCreditLine(text) {
  var t = String(text || '')
  return CREDIT_COLON_RE.test(t) || CREDIT_SPACE_RE.test(t)
}
export function parseLrc(text) {
  const out = []
  const raw = String(text || '')
  if (!raw) return out
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 抓出这一行里所有时间标签
    const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
    const times = []
    let m
    let lastEnd = 0
    while ((m = re.exec(line)) !== null) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      let frac = 0
      if (m[3] != null) {
        const f = m[3]
        frac = f.length === 3 ? parseInt(f, 10) / 1000
          : f.length === 2 ? parseInt(f, 10) / 100
            : parseInt(f, 10) / 10
      }
      const t = min * 60 + sec + frac
      if (isFinite(t)) times.push(t)
      lastEnd = re.lastIndex
    }
    if (!times.length) continue          // 元数据行 / 空行
    let content = line.slice(lastEnd)
    // 去掉行内的增强标签（QQ音乐有时会带 <00:01.00> 这种逐字标签）
    content = content.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
    content = content.trim()
    if (!content) continue
    // 制作人员行（作词 : / 作曲 : …）：带时间戳的元数据，不是歌词 —— 跳过。
    // 不过滤的话，歌曲前 30 秒气泡里全是"作词/作曲"在闪（用户实测）。
    if (isCreditLine(content)) continue
    for (let k = 0; k < times.length; k++) out.push({ t: times[k], text: content })
  }
  out.sort((a, b) => a.t - b.t)
  // ⚠️ 这里**刻意不做"相邻重复去重"**。
  //    一开始写了去重，结果把 `[00:05.5][00:10.0]同一句` 这种
  //    "一行挂多个时间标签"的第二个时间点删掉了 —— 时间轴就缺了一块。
  //    显示层只在文字真的变了才重绘，所以留着重复项没有代价。
  return out
}

// 按当前播放位置找出该显示哪一句
export function lineAt(lines, pos) {
  if (!Array.isArray(lines) || !lines.length) return null
  if (!isFinite(pos) || pos < 0) return lines[0].text
  let cur = lines[0]
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= pos + 0.15) cur = lines[i]
    else break
  }
  return cur.text
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------
async function getText(url, referer) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer || QQ_REFERER,
      Accept: 'application/json, text/plain, */*',
    },
  })
  return { status: r.status, text: await r.text() }
}

// QQ音乐返回的 JSON 里偶尔带 HTML 实体（&#58; 之类），解一下更保险
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
}

async function qqSearch(title, artist, log) {
  const kw = [title, artist].filter(Boolean).join(' ')
  const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=20&w=' + encodeURIComponent(kw)
  const r = await getText(url)
  let j = null
  try { j = JSON.parse(r.text) } catch (e) {
    // 有的接口会包一层 MusicJsonCallback(...)
    const m = /^[A-Za-z_$][\w$]*\((.*)\)\s*;?\s*$/s.exec(r.text.trim())
    if (m) { try { j = JSON.parse(m[1]) } catch (e2) {} }
  }
  if (!j) { log('搜索返回不是 JSON'); return [] }
  const list = (j.data && j.data.song && j.data.song.list) || []
  return list.map((s) => ({
    mid: s.songmid,
    name: decodeEntities(s.songname),
    singers: (s.singer || []).map((a) => decodeEntities(a.name)).filter(Boolean),
    interval: s.interval,
  })).filter((s) => s.mid)
}

// —— 字符串相似度：Dice 系数（按二元组）——
// 为什么不用"子串包含"：实测踩过 ——
//   查「这首歌根本不存在zzzqqq」，候选里有首《这首歌》，
//   `长串.indexOf('这首歌') === 0` 成立，于是白拿 55 分，最后显示了别人的歌词。
//   子串包含对"候选名很短、查询串很长"这种情况毫无抵抗力。
// Dice 会把长度差异算进去：上面那对只有 0.29，而真正该匹配的
//   「青花瓷」vs「青花瓷周杰伦」有 0.57 —— 正好能分开。
function dice(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (s) => {
    if (s.length < 2) return [s]
    const out = []
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  const map = new Map()
  for (const g of ga) map.set(g, (map.get(g) || 0) + 1)
  let hit = 0
  for (const g of gb) {
    const n = map.get(g) || 0
    if (n > 0) { hit++; map.set(g, n - 1) }
  }
  return (2 * hit) / (ga.length + gb.length)
}

// 在候选里挑最像的那一首。
// 打分（实测调出来的）：
//   · 歌名几乎一字不差（相似度 ≥0.99）      +100
//     ⚠️ 查询**带歌手**时，+100 还要求歌手对得上 —— 网易云的搜索排序差，
//     常把"同名翻唱"排前面；歌名一致但歌手对不上 → 只有基础分，
//     过不了 MIN_SCORE 就当没找到（显示错的歌词比不显示糟得多）。
//     查询**没带歌手**（有些平台不报）时没法验歌手，只能认歌名。
//   · 歌名只是"像"（≥0.5）**且歌手也对得上** +55
//   · 歌手对得上                            +40
//   · **原名和要查的歌名一字不差**            +12
//   · 原名比歌名长得越多扣得越多（最多 -6）
//   · **时长**（可选，秒）：与正在播的时长差 ≤8s +10；差 >20s -35 ——
//     这是防"同名翻唱/加速版"的硬闸：翻唱可以同名同歌手（翻唱合集），
//     但时长几乎不可能一模一样。
// 后两条是为了让「青花瓷」赢过「青花瓷 (Live)」：
//   两者归一化后都是「青花瓷」、歌手都是周杰伦，本来会**平分**，
//   而平分时取搜索列表里第一个 —— 实测正好把 Live 版排在前面。
//
// ⚠️ "歌名只是像"时必须**有歌手背书**：这是防"显示别人歌词"的第二道闸。
//    没有歌手信息时，只有歌名几乎一字不差才认。
function pickBest(list, title, artist, durSec) {
  if (!list.length) return null
  const nt = normName(title)
  const na = normName(artist)
  const dur = Number(durSec)
  const hasDur = isFinite(dur) && dur > 0
  const candDur = (s) => {
    const v = Number(s.interval)
    if (!isFinite(v) || v <= 0) return -1
    return v > 10000 ? v / 1000 : v        // 有的源给毫秒，统一成秒
  }
  const score = (s) => {
    const sn = normName(s.name)
    const sa = s.singers.map(normName).join('')
    const sim = dice(sn, nt)
    const artistOk = !!(na && sa && (sa.indexOf(na) >= 0 || na.indexOf(sa) >= 0))
    let v = 0
    if (sim >= 0.99) v += (artistOk || !na) ? 100 : 40
    else if (sim >= 0.5 && artistOk) v += 55
    if (artistOk) v += 40
    if (String(s.name) === String(title)) v += 12
    const extra = Math.max(0, String(s.name).length - String(title).length)
    v -= Math.min(6, extra)
    if (hasDur) {
      const cd = candDur(s)
      if (cd > 0) {
        const diff = Math.abs(cd - dur)
        if (diff <= 8) v += 10
        else if (diff > 20) v -= 35
      }
    }
    return v
  }
  let best = list[0]
  let bestV = -Infinity
  for (const s of list) {
    const v = score(s)
    if (v > bestV) { bestV = v; best = s }
  }
  return { song: best, score: bestV }
}

// 相关度门槛：低于它就当"没找到"。
// ⚠️⚠️ 这条是必须的，实测踩过：
//    搜一个**根本不存在的歌名**（"这首歌根本不存在zzzqqq"），QQ音乐照样返回
//    一堆松散相关的结果，而旧代码"挑不出就取第一个"——
//    于是气泡里会一本正经地显示**另一首歌的歌词**。
//    显示错的歌词比不显示歌词糟得多，所以宁可返回空。
//    50 分 = 至少要有"歌名包含关系"，光靠歌手对上是不过关的。
const MIN_SCORE = 50

async function qqLyric(mid) {
  const url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' +
    encodeURIComponent(mid) + '&format=json&nobase64=1&g_tk=5381'
  const r = await getText(url)
  let j = null
  try { j = JSON.parse(r.text) } catch (e) {
    const m = /^[A-Za-z_$][\w$]*\((.*)\)\s*;?\s*$/s.exec(r.text.trim())
    if (m) { try { j = JSON.parse(m[1]) } catch (e2) {} }
  }
  if (!j) return null
  if (j.retcode !== 0) return null
  const lrc = decodeEntities(j.lyric || '')
  if (!lrc) return null
  return { lrc, trans: decodeEntities(j.trans || '') }
}

// ---------------------------------------------------------------------------
// 超时包装
// ---------------------------------------------------------------------------
// fetch 本身不带超时。QQ 挂掉时是"连上但 5 秒才回 500"，
// 不设超时的话整条链会被它拖住，用户等 5 秒才看到"没找到"。
function withTimeout(promise, ms, what) {
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + ' 超时 ' + ms + 'ms')), ms)
  })
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer) })
}

// ---------------------------------------------------------------------------
// 酷狗（三步）
// ---------------------------------------------------------------------------
// ⚠️ 酷狗取歌词要**三步**，不像 QQ 那样一步到位（下面第 ① 步已换成证书正常的域名）：
//   ① 搜索拿 hash  ② 用 hash + 关键词换 id/accesskey  ③ 用 id/accesskey 下载
//   所以候选对象里要**多带 hash 和当时的 kw**，第 ③ 步要用。
// 返回的歌词是 **base64** 编码的 LRC，要解一次。
async function kugouSearch(title, artist, log) {
  const kw = [title, artist].filter(Boolean).join(' ')
  // ⚠️⚠️ **别用 `mobilecdn.kugou.com`。**
  //    它在这台机器上会抛 `ERR_TLS_CERT_ALTNAME_INVALID` ——
  //    证书里的域名和实际访问的域名对不上，Node 的 fetch 严格校验直接拒。
  //    （curl 加 `-k` 跳过校验所以看着是通的，很容易误判成"接口没问题"。）
  //    `songsearch.kugou.com` 证书正常，返回结构也更好（data.lists）。
  const url = 'https://songsearch.kugou.com/song_search_v2?format=json&page=1&pagesize=20&keyword=' +
    encodeURIComponent(kw)
  const r = await getText(url, 'https://www.kugou.com/')
  let j = null
  try { j = JSON.parse(r.text) } catch (e) { log('酷狗搜索返回不是 JSON'); return [] }
  const info = (j.data && j.data.lists) || []
  return info.map((s) => ({
    src: 'kugou',
    mid: s.FileHash,                // 后续两步都用 hash
    hash: s.FileHash,
    kw: kw,
    name: String(s.SongName || ''),
    // 歌手可能是「周杰伦、方文山」这种，拆开好做匹配
    singers: String(s.SingerName || '').split(/[、,，&/]/).map((x) => x.trim()).filter(Boolean),
    interval: s.Duration,
  })).filter((s) => s.mid)
}

async function kugouLyric(cand, log) {
  // ② 换 id + accesskey
  const u2 = 'https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=' +
    encodeURIComponent(cand.kw || cand.name) + '&hash=' + encodeURIComponent(cand.hash)
  const r2 = await getText(u2, 'https://www.kugou.com/')
  let j2 = null
  try { j2 = JSON.parse(r2.text) } catch (e) { log('酷狗定位返回不是 JSON'); return null }
  const list = (j2.candidates || []).filter((x) => x && x.id && x.accesskey)
  if (!list.length) return null
  const pick = list[0]
  // ③ 下载（base64 的 LRC）
  const u3 = 'https://lyrics.kugou.com/download?ver=1&client=pc&id=' + encodeURIComponent(pick.id) +
    '&accesskey=' + encodeURIComponent(pick.accesskey) + '&fmt=lrc&charset=utf8'
  const r3 = await getText(u3, 'https://www.kugou.com/')
  let j3 = null
  try { j3 = JSON.parse(r3.text) } catch (e) { log('酷狗下载返回不是 JSON'); return null }
  const b64 = j3.content || ''
  if (!b64) return null
  let lrc = ''
  try {
    lrc = Buffer.from(b64, 'base64').toString('utf8')
  } catch (e) { log('酷狗歌词 base64 解码失败'); return null }
  if (!lrc) return null
  return { lrc, trans: '' }
}

// ---------------------------------------------------------------------------
// 网易云（两步）
// ---------------------------------------------------------------------------
// ⚠️ 只作**最后兜底**：两步都通，但搜索排序差 ——
//    搜「晴天 周杰伦」前三条全是翻唱，靠 pickBest 的歌手匹配才可能挑回原唱，
//    挑不回来时会因为相关度不足（MIN_SCORE）被丢弃，也就是"没找到"。
//    这比显示错的歌词好。
async function neteaseSearch(title, artist, log) {
  const kw = [title, artist].filter(Boolean).join(' ')
  const url = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(kw) +
    '&type=1&offset=0&limit=20'
  const r = await getText(url, NETEASE_REFERER)
  let j = null
  try { j = JSON.parse(r.text) } catch (e) { log('网易云搜索返回不是 JSON'); return [] }
  const songs = (j.result && j.result.songs) || []
  return songs.map((s) => ({
    src: 'netease',
    mid: String(s.id || ''),
    name: String(s.name || ''),
    singers: (s.artists || []).map((a) => String(a.name || '')).filter(Boolean),
    interval: s.duration,
  })).filter((s) => s.mid)
}

async function neteaseLyric(cand, log) {
  const url = 'https://music.163.com/api/song/lyric?id=' + encodeURIComponent(cand.mid) +
    '&lv=-1&kv=-1&tv=-1'
  const r = await getText(url, NETEASE_REFERER)
  let j = null
  try { j = JSON.parse(r.text) } catch (e) { log('网易云歌词返回不是 JSON'); return null }
  const lrc = (j.lrc && j.lrc.lyric) || ''
  if (!lrc) return null
  return { lrc, trans: (j.tlyric && j.tlyric.lyric) || '' }
}

// —— 按 src 分派"取歌词" ——
async function lyricBySrc(cand, log) {
  if (cand.src === 'kugou') return kugouLyric(cand, log)
  if (cand.src === 'netease') return neteaseLyric(cand, log)
  return qqLyric(cand.mid)
}

// —— 提供者清单（顺序 = 优先级）——
// 酷狗最准放第一；QQ 结构最干净但现在 500，排第二等它恢复；
// **网易云排第三**（2026-09-28 启用）——原先故意排除它，是因为 pickBest
// 的"歌名一致就满分、不看歌手"会稳稳挑中翻唱；现在 +100 要求歌手对得上、
// 且有时长硬闸（差 >20s 直接 -35），实测风险已被两道闸压住。
// 多一个兜底源 = 少一类"这个平台放的歌查不到词"。
const PROVIDERS = [
  { name: 'kugou', search: kugouSearch },
  { name: 'qqmusic', search: qqSearch },
  { name: 'netease', search: neteaseSearch },
]

// —— 纯音乐占位行 ——
// ⚠️ 实测踩到的：本机 echo-music 放的是**纯音乐**，QQ音乐给的 LRC 里
//    只有一句「此歌曲为没有填词的纯音乐，请您欣赏」。
//    这不是歌词，是音源方的占位说明。直接显示它的话，
//    气泡会一直挂着一句"没有填词"——既不是歌词，也把歌名/作者挤掉了。
//    所以：**整首歌只有 1~2 句、且每句都命中占位特征**时，当作"没有歌词"处理，
//    退回歌名/作者版式。（要求"每句都命中"是为了绝不误伤真歌词。）
const PLACEHOLDER_RE = /(纯音乐|没有填词|无歌词|暂无歌词|请欣赏|此歌曲为|instrumental)/i

export function isPlaceholderOnly(lines) {
  if (!Array.isArray(lines) || !lines.length) return false
  if (lines.length > 2) return false
  for (let i = 0; i < lines.length; i++) {
    if (!PLACEHOLDER_RE.test(String(lines[i].text || ''))) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 对外：按"歌名 + 歌手"拿歌词
// ---------------------------------------------------------------------------
export function createLyrics({ log } = {}) {
  const say = logWith(log)
  const cache = new Map()          // key -> { lines } / { lines: [] }（查不到也缓存，别反复打接口）
  const MAX = 120

  // ⚠️ 缓存 key 带时长桶（30s 粒度）：同名同歌手的不同版本（原版/加速版/现场版）
  //    歌词不一样，只用「歌名|歌手」会命中错词。调用方 fetch(title, artist, durSec)
  //    本来就带时长，只是之前没参与 key。
  function key(title, artist, durSec) {
    return normName(title) + '|' + normName(artist) + '|' + Math.round((Number(durSec) || 0) / 30)
  }

  return {
    /**
     * @param {number} [durSec] 正在播的这首歌的总时长（秒）——
     *        用来在候选里排除翻唱/加速版（时长差 >20s 直接不要）
     * @returns {Promise<{lines:Array<{t:number,text:string}>, source:string, matched?:string}>}
     *          查不到时 lines 为空数组（**不抛异常** —— 歌词失败不该影响歌名显示）
     */
    async fetch(title, artist, durSec) {
      const k = key(title, artist, durSec)
      if (cache.has(k)) return cache.get(k)
      let result = { lines: [], source: 'none' }
      // —— 按优先级逐个源试，谁先出结果用谁 ——
      // 每家单独限时（PROVIDER_TIMEOUT_MS），一家卡住/挂掉不影响下一家。
      // 全部失败才认输 —— 这正是不再"所有平台都识别不到"的关键。
      for (const prov of PROVIDERS) {
        if (result.lines.length) break
        try {
          const cands = await withTimeout(prov.search(title, artist, say),
            PROVIDER_TIMEOUT_MS, prov.name + ' 搜索')
          const pick = pickBest(cands, title, artist, durSec)
          if (!pick) {
            say(prov.name + '：没搜到「' + title + ' - ' + artist + '」')
            continue
          }
          if (pick.score < MIN_SCORE) {
            // 相关度太低 —— 当作没找到，绝不显示别人的歌词
            say(prov.name + '：相关度太低（' + pick.score + '），不采用：' + pick.song.name)
            continue
          }
          const best = pick.song
          const got = await withTimeout(lyricBySrc(best, say),
            PROVIDER_TIMEOUT_MS, prov.name + ' 取词')
          const lines = got ? parseLrc(got.lrc) : []
          if (lines.length && isPlaceholderOnly(lines)) {
            // 纯音乐的占位说明 —— 当作没歌词，别让气泡一直挂着"没有填词"。
            // 但**不 continue**：换一家说不定有真歌词（QQ 常给占位、酷狗有）。
            say(prov.name + '：这首是纯音乐（只有占位说明），换下一家')
            continue
          }
          if (lines.length) {
            result = { lines, source: prov.name, matched: best.name + ' - ' + best.singers.join('&') }
            say('找到歌词（' + prov.name + '）：' + result.matched +
              '（' + lines.length + ' 句，相关度 ' + pick.score + '）')
          } else {
            say(prov.name + '：搜到了但没歌词：' + best.name)
          }
        } catch (e) {
          // 单个源失败**不能**让整个查询失败 —— 继续下一家
          say(prov.name + ' 失败：' + (e && e.message))
        }
      }
      if (!result.lines.length) say('三个源都没拿到歌词')
      if (cache.size >= MAX) {
        // 简单的 FIFO 淘汰：Map 的迭代顺序就是插入顺序
        const first = cache.keys().next()
        if (!first.done) cache.delete(first.value)
      }
      cache.set(k, result)
      return result
    },
    clear() { cache.clear() },
    size() { return cache.size },
  }
}

export { pickBest, normName, dice, PROVIDERS }
