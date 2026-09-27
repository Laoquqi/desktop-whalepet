// ============================================================================
// 凭据读写 —— 桌面版没有 DSH 的凭据服务，这里自己实现一份等价的
// ============================================================================
// 存放位置：<数据目录>/credentials.json
//   { "DEEPSEEK_API_KEY": "sk-…" }
// 由本应用的「设置」界面写入。
//
// ⚠️ 为什么不直接去读用户 DSH 的 ~/.dsh/.credentials.yaml：
//    那是 DSH 的内部存储格式（records.<ref>.secret 结构，DEEPSEEK_API_KEY 存的
//    只是一个**引用 id** 而不是密钥本体）。本文件最初实现过一版"容错解析"，
//    结果把引用值当成密钥发给了上游接口 —— 是**真出过的 bug**。
//    依赖别人私有的、未公开的存储格式本身就不可靠，所以这里不读 DSH 的任何文件，
//    只用自己的 credentials.json。
//
// ⚠️ 本文件只读写本机文件，不联网、不上传。
//    任何密钥值都不得进入日志、错误文案或界面回显 —— 日志里只允许出现"有没有"。
import fs from 'node:fs'
import path from 'node:path'

export function createCredentials({ dataDir, log = () => {} }) {
  const file = path.join(dataDir, 'credentials.json')

  function readStore() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      return j && typeof j === 'object' ? j : {}
    } catch (err) {
      return {}
    }
  }

  function writeStore(obj) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 })
      return true
    } catch (err) {
      log('凭据写入失败', err && err.message)
      return false
    }
  }

  return {
    /** 与 DSH 的 ctx.credentials.resolve 同形：返回 { name, value } 或 null */
    async resolve(name) {
      if (!name) return null
      const store = readStore()
      const value = store[name]
      if (!value) return null
      return { name, value, source: 'app' }
    },

    /** 与 DSH 的 ctx.credentials.set 同形 */
    async set(name, value) {
      if (!name) return false
      const store = readStore()
      if (value === null || value === undefined || value === '') delete store[name]
      else store[name] = String(value)
      const ok = writeStore(store)
      // ⚠️ 只记录"是否已设置"，绝不记录值本身
      log(ok ? '凭据已更新' : '凭据更新失败', name, value ? '(已设置)' : '(已清除)')
      return ok
    },

    /** 给界面用：只回"有没有配"，不回值 */
    async status(name) {
      const store = readStore()
      return { configured: !!store[name], source: store[name] ? 'app' : 'none' }
    },

    path: file,
  }
}
