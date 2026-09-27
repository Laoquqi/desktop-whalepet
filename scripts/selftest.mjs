// 端到端自检入口：npm run selftest
//
// 为什么要包一层：
//   ① Electron 在 Windows 上是 GUI 子系统程序，**console.log 不会回到父进程的终端** ——
//      所以自检结果写在 <数据目录>/selftest.txt，这里读出来打印。
//   ② 必须清掉 NODE_OPTIONS：Electron 主进程会继承它，某些工具往里塞的
//      --require=xxx.cjs 会干扰 require('electron') 的解析（表现为启动即崩）。
//   ③ 自检模式不显示窗口（主进程以 show:false 创建窗口且不调用 show），
//      所以跑它不会在桌面上弹东西。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', '大肥鱼桌宠')
const REPORT = path.join(DATA_DIR, 'selftest.txt')

const electronBin = process.platform === 'win32'
  ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(ROOT, 'node_modules', '.bin', 'electron')

if (!fs.existsSync(electronBin)) {
  console.error('找不到 Electron 运行库，请先 npm install')
  process.exit(1)
}

try { fs.rmSync(REPORT, { force: true }) } catch (err) {}

const env = { ...process.env, PET_SELFTEST: '1' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronBin, ['.'], { cwd: ROOT, env, stdio: 'ignore' })

const timer = setTimeout(() => { try { child.kill() } catch (err) {} }, 300000)

child.on('exit', (code) => {
  clearTimeout(timer)
  let report = ''
  try { report = fs.readFileSync(REPORT, 'utf8') } catch (err) {}
  if (!report) {
    console.error('没有拿到自检报告。请查看', path.join(DATA_DIR, 'pet.log'))
    process.exit(1)
  }
  console.log(report.trim())
  const failed = /失败 ([1-9]\d*)/.exec(report)
  process.exit(failed || code !== 0 ? 1 : 0)
})
