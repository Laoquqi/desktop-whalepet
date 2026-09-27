// ============================================================================
// 歌词：搜索 + 取 LRC + 解析
// ============================================================================
// 音源选择（实测过的，不是照抄网上教程）：
//   · **QQ音乐** ✅ 唯一一个两条都通的：
//       搜索  https://c.y.qq.com/soso/fcgi-bin/client_search_cp  → 拿到 songmid
//       歌词  https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg
//       实测 retcode=0，LRC 988 字节 / 44 行带时间轴，中文正常。
//   · 网易云 ❌ 搜索还能用，但歌词接口现在大量返回**空 LRC**
//       （实测同一个歌名下 4 个结果里 3 个 lrc.lyric 长度是 0）—— 基本是登录墙。
//   · 酷狗 ❌ 这台机器上 krcs/mobilecdn 直接 fetch failed（DNS/连通性），
//       连搜索都过不去，没法作为主源。
//   所以只做 QQ音乐一个源；查不到就老实显示"没找到歌词"，
//   而不是拿一个空字符串假装成功。
//
// 为什么需要时间轴（LRC）：用户要的是"一句接一句"。
//   GSMTC 给了当前播放位置（pos），拿 LRC 的时间轴一比，
//   就知道此刻该显示哪一句 —— 这才是跟着音乐走的歌词，
//   而不是把整首歌一次性倒出来。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const QQ_REFERER = 'https://y.qq.com/portal/player.html'

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
  const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=10&w=' + encodeURIComponent(kw)
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
//   · 歌名只是"像"（≥0.5）**且歌手也对得上** +55
//   · 歌手对得上                            +40
//   · **原名和要查的歌名一字不差**            +12
//   · 原名比歌名长得越多扣得越多（最多 -6）
// 后两条是为了让「青花瓷」赢过「青花瓷 (Live)」：
//   两者归一化后都是「青花瓷」、歌手都是周杰伦，本来会**平分**，
//   而平分时取搜索列表里第一个 —— 实测正好把 Live 版排在前面。
//
// ⚠️ "歌名只是像"时必须**有歌手背书**：这是防"显示别人歌词"的第二道闸。
//    没有歌手信息时，只有歌名几乎一字不差才认。
function pickBest(list, title, artist) {
  if (!list.length) return null
  const nt = normName(title)
  const na = normName(artist)
  const score = (s) => {
    const sn = normName(s.name)
    const sa = s.singers.map(normName).join('')
    const sim = dice(sn, nt)
    const artistOk = !!(na && sa && (sa.indexOf(na) >= 0 || na.indexOf(sa) >= 0))
    let v = 0
    if (sim >= 0.99) v += 100
    else if (sim >= 0.5 && artistOk) v += 55
    if (artistOk) v += 40
    if (String(s.name) === String(title)) v += 12
    const extra = Math.max(0, String(s.name).length - String(title).length)
    v -= Math.min(6, extra)
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

  function key(title, artist) { return normName(title) + '|' + normName(artist) }

  return {
    /**
     * @returns {Promise<{lines:Array<{t:number,text:string}>, source:string, matched?:string}>}
     *          查不到时 lines 为空数组（**不抛异常** —— 歌词失败不该影响歌名显示）
     */
    async fetch(title, artist) {
      const k = key(title, artist)
      if (cache.has(k)) return cache.get(k)
      let result = { lines: [], source: 'none' }
      try {
        const cands = await qqSearch(title, artist, say)
        const pick = pickBest(cands, title, artist)
        if (!pick) {
          say('没搜到「' + title + ' - ' + artist + '」')
        } else if (pick.score < MIN_SCORE) {
          // 相关度太低 —— 当作没找到，绝不显示别人的歌词
          say('相关度太低（' + pick.score + '），不采用搜索结果：' + pick.song.name)
        } else {
          const best = pick.song
          const got = await qqLyric(best.mid)
          const lines = got ? parseLrc(got.lrc) : []
          if (lines.length && isPlaceholderOnly(lines)) {
            // 纯音乐的占位说明 —— 当作没歌词，别让气泡一直挂着"没有填词"
            say('这首是纯音乐（音源只有占位说明），按"没有歌词"处理')
          } else if (lines.length) {
            result = { lines, source: 'qqmusic', matched: best.name + ' - ' + best.singers.join('&') }
            say('找到歌词：' + result.matched + '（' + lines.length + ' 句，相关度 ' + pick.score + '）')
          } else {
            say('搜到了但没歌词：' + best.name)
          }
        }
      } catch (e) {
        say('取歌词失败：' + (e && e.message))
      }
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

export { pickBest, normName, dice }
