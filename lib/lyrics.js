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
// 伴奏 / 纯音乐 / 卡拉OK 版：时间轴是按无人声编排的，和原版对不上。
// 实测（2026-10-26）：晚夜微雨问海棠 匹配到「晚夜微雨问海棠 伴奏」，
// 相关度 57 勉强过 MIN_SCORE，但整首歌的时间轴和原版不同 → 歌词整体偏移。
// 宁可没歌词，也不要一个错的版本。
const INSTRUMENTAL_RE = /(伴奏|纯音乐|instrumental|off\s*vocal|karaoke|消音|无人声)/i

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
    // 伴奏 / 纯音乐版：分数直接压到 MIN_SCORE 以下，等于排除
    if (INSTRUMENTAL_RE.test(String(s.name || ''))) v -= 120
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

async function kugouLyric(cand, log, target) {
  // ② 换 id + accesskey
  const u2 = 'https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=' +
    encodeURIComponent(cand.kw || cand.name) + '&hash=' + encodeURIComponent(cand.hash)
  const r2 = await getText(u2, 'https://www.kugou.com/')
  let j2 = null
  try { j2 = JSON.parse(r2.text) } catch (e) { log('酷狗定位返回不是 JSON'); return null }
  const list = (j2.candidates || []).filter((x) => x && x.id && x.accesskey)
  if (!list.length) return null
  // ---------------------------------------------------------------------
  // ⚠️⚠️ **不能直接取 list[0]**（2026-10-26 用户实测踩到）。
  //    krcs 的候选里会混进酷狗自己的**铃声 / 推广条目**，而且排在最前面：
  //        [0] song=酷狗音乐          singer=酷狗音乐            id=14336409
  //        [1] song=晚夜微雨问海棠    singer=镜予歌、喧笑、陈亦洺  id=62134844
  //    取 [0] 的后果：歌词全文只有一句「酷狗音乐  就是歌多」
  //    （元数据是 [ti:铃声] [ar:薛之谦]），而因为它**有内容**，
  //    fetch() 里就不会再试 QQ / 网易云 —— 这句广告直接成了最终歌词。
  //    所以这里按「歌名 + 歌手」给候选打分，低于 MIN_SCORE 就返回 null，
  //    让 fetch() 继续问下一家。宁可不显示，也不显示错的。
  const shaped = list.map((c) => ({
    name: String(c.song || ''),
    singers: String(c.singer || '').split(/[、,，&/]/).map((x) => x.trim()).filter(Boolean),
    interval: c.duration,
    raw: c,
  }))
  // ⚠️⚠️ 目标用**用户实际在播的那首**（SMTC 给的原始歌名），而不是搜索结果第一条的名字。
  //    实测（2026-10-26）：搜「晚夜微雨问海棠」，kugouSearch 第一条是「(网友改编)」版，
  //    于是 target 也带着这个后缀 → pickBest 里「名字完全相等 +12」给改编版加了分，
  //    纯同名那条反而加不到 → 选中改编版。改编版的编曲/节奏和原版不同，
  //    歌词**时间轴整体错位**，用户看到的就是"完全对不上、差很多"。
  //    换成原始歌名后：纯同名候选 sim=1 且完全相等 +12，得分反超改编版。
  const tTitle = (target && target.title) || cand.name || ''
  const tArtist = (target && target.artist) || (cand.singers && cand.singers[0]) || ''
  const tDur = (target && isFinite(Number(target.durSec))) ? Number(target.durSec) : 0
  const picked = pickBest(shaped, tTitle, tArtist, tDur)
  if (!picked || picked.score < MIN_SCORE) {
    log('酷狗歌词候选都不匹配（最高 ' + (picked ? picked.score : '无') + '）：' +
      shaped.slice(0, 4).map((x) => x.name).join(' / '))
    return null
  }
  const pick = picked.song.raw
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
// target = 用户实际在播的那首（{ title, artist, durSec }，来自 SMTC）。
// 取词阶段还要用它做**二次匹配**：搜索结果第一条常常是「(网友改编)」「(DJ版)」这类
// 衍生版本，直接拿它当目标会一路错下去（见 kugouLyric 里的说明）。
async function lyricBySrc(cand, log, target) {
  if (cand.src === 'kugou') return kugouLyric(cand, log, target)
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

// —— 广告 / 铃声歌词 ——
// ⚠️ 实测（2026-10-26）：酷狗的铃声库会以正常歌词的形式返回，
//    整首歌就一句「酷狗音乐  就是歌多」（[ti:铃声]）。它不是占位说明，
//    PLACEHOLDER_RE 拦不住，但显示出来比"没歌词"更糟 —— 气泡会一直挂着广告。
//    判定条件跟 isPlaceholderOnly 同款**保守**：句子很少、且**每一句**都命中，
//    真歌词几乎不可能整首都在念平台名。
const JUNK_RE = /(酷狗音乐|QQ音乐|网易云音乐|酷我音乐|就是歌多|海量正版|下载客户端|铃声)/i

export function isJunkOnly(lines) {
  if (!Array.isArray(lines) || !lines.length) return false
  if (lines.length > 3) return false
  for (let i = 0; i < lines.length; i++) {
    if (!JUNK_RE.test(String(lines[i].text || ''))) return false
  }
  return true
}

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

  // 缓存 key 必须带上**时长档位**：同一首歌名可能是完全不同的版本
  // （All Time Low 原版 200 秒 / slowed 版 242 秒；晚夜微雨问海棠原版 282 / DJ 版 226 / 改编 252），
  // 不带时长的话先查到的那个版本会被后续所有版本复用 —— 实测过，串味。
  // 10 秒一档：既能区分版本，又不会被 ±1 秒的抖动打穿缓存。
  function key(title, artist, dur) {
    const d = Number(dur) > 0 ? Math.round(Number(dur) / 10) : 0
    return normName(title) + '|' + normName(artist) + '|' + d
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
      // —— 按优先级逐个源试，但**不是谁先出结果就用谁** ——
      // ⚠️⚠️ 必须校验「歌词时长 vs 实际时长」（2026-10-26 用户实测）。
      //    All Time Low 就是典型：酷狗歌词库里只有 slowed 版（242 秒），
      //    用户播的是原版（200 秒）。歌名一模一样，时长差 42 秒 ——
      //    242/200 = 1.21，每句歌词只停留 1/1.21 的时间，表现正是
      //    「lyrics by 那行切得太快、歌词永远快一句」。
      //    所以：时长对不上的候选先收着，继续问下一家；最后取**时长差最小**的。
      //    第一家就匹配（≤8%）则立刻采用，不额外增加延迟。
      //
      //    为什么用「最后一句的时间」而不是 LRC 的 [total:]：
      //      · [total:] 很多源不写（QQ 全都没有）
      //      · 最后一句一定比总时长小一点（尾奏留白），所以容差取 max(8%, 6s)
      const pool = []
      for (const prov of PROVIDERS) {
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
          const got = await withTimeout(lyricBySrc(best, say, { title, artist, durSec }),
            PROVIDER_TIMEOUT_MS, prov.name + ' 取词')
          const lines = got ? parseLrc(got.lrc) : []
          if (lines.length && isPlaceholderOnly(lines)) {
            // 纯音乐的占位说明 —— 当作没歌词，别让气泡一直挂着"没有填词"。
            // 但**不 continue**：换一家说不定有真歌词（QQ 常给占位、酷狗有）。
            say(prov.name + '：这首是纯音乐（只有占位说明），换下一家')
            continue
          }
          if (lines.length && isJunkOnly(lines)) {
            // 广告 / 铃声歌词（酷狗的「酷狗音乐  就是歌多」）—— 同样换下一家。
            say(prov.name + '：拿到的是广告/铃声歌词（' + lines[0].text + '），换下一家')
            continue
          }
          if (lines.length) {
            const lastT = lines[lines.length - 1].t
            const diff = durSec > 0 ? Math.abs(lastT - durSec) : 0
            const durOk = !(durSec > 0) || diff <= Math.max(durSec * 0.08, 6)
            pool.push({
              lines,
              source: prov.name,
              matched: best.name + ' - ' + best.singers.join('&'),
              diff,
              durOk,
            })
            say('拿到歌词（' + prov.name + '）：' + best.name +
              '（' + lines.length + ' 句，相关度 ' + pick.score +
              (durSec > 0
                ? '，最后一句 ' + Math.round(lastT) + 's / 实际 ' + Math.round(durSec) + 's'
                : '') + '）' + (durSec > 0 ? (durOk ? ' ✓ 时长匹配' : ' ✗ 时长不符') : ''))
            // 时长匹配就够了；不匹配的话最多再问一家（两个源一般够分辨版本）
            if (durOk || pool.length >= 2) break
          } else {
            say(prov.name + '：搜到了但没歌词：' + best.name)
          }
        } catch (e) {
          // 单个源失败**不能**让整个查询失败 —— 继续下一家
          say(prov.name + ' 失败：' + (e && e.message))
        }
      }
      if (pool.length) {
        pool.sort((a, b) => a.diff - b.diff)
        const win = pool[0]
        result = { lines: win.lines, source: win.source, matched: win.matched }
        if (!win.durOk) {
          say('⚠ 没有时长匹配的歌词，取了最接近的：' + win.matched +
            '（差 ' + Math.round(win.diff) + 's）—— 歌词可能整体偏移')
        }
        say('采用 ' + win.source + '：' + win.matched + '（' + win.lines.length + ' 句）')
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
