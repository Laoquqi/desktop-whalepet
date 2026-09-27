// 验证**打包产物**：npm run verify:packaged
//
// 为什么需要它：
//   开发自检（npm run selftest）跑的是**源码目录**，验证不到打包后的东西 ——
//   而打包会改变运行环境（asar 只读归档、ROOT 指向 app.asar、绝对路径、图标加载……），
//   这些差异在源码模式下永远测不出来。
//
// 用法：
//   npm run verify:packaged              # 免安装目录版（默认）
//   npm run verify:packaged -- portable  # 便携版单文件
//   npm run verify:packaged -- asar      # 用 dev Electron 加载打包出来的 app.asar
//
// 和 selftest.mjs 一样要包一层：Electron 在 Windows 上是 GUI 子系统程序，
// console.log 不回父进程终端，所以结果读 <数据目录>/selftest.txt。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', '大肥鱼桌宠')
const REPORT = path.join(DATA_DIR, 'selftest.txt')

const which = (process.argv[2] || 'unpacked').toLowerCase()

const unpacked = path.join(ROOT, 'dist', 'win-unpacked', '大肥鱼桌宠.exe')
const portable = path.join(ROOT, '大肥鱼桌宠.exe')
const asar = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')
const devElectron = process.platform === 'win32'
  ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(ROOT, 'node_modules', '.bin', 'electron')

let bin, args, label
if (which === 'portable') { bin = portable; args = []; label = '便携版单文件' }
else if (which === 'asar') { bin = devElectron; args = [asar]; label = 'dev Electron + 打包 app.asar' }
else { bin = unpacked; args = []; label = '免安装目录版' }

if (!fs.existsSync(bin)) {
  console.error('找不到目标：' + bin)
  console.error('（先 npm run build）')
  process.exit(1)
}

try { fs.rmSync(REPORT, { force: true }) } catch (err) {}

const env = { ...process.env, PET_SELFTEST: '1' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE

console.log('验证目标：' + label)
console.log('  路径：' + bin)
console.log('  （自检不显示窗口，不会在桌面上弹东西）')

const child = spawn(bin, args, { cwd: ROOT, env, stdio: 'ignore' })

// 便携版首次启动要解压 + 杀毒扫描，给足时间
const timer = setTimeout(() => { try { child.kill() } catch (err) {} }, 240000)

child.on('error', (err) => {
  clearTimeout(timer)
  console.error('启动失败：' + err.message)
  process.exit(1)
})

child.on('exit', (code) => {
  clearTimeout(timer)
  let report = ''
  try { report = fs.readFileSync(REPORT, 'utf8') } catch (err) {}
  if (!report) {
    console.error('没有拿到自检报告（退出码 ' + code + '）。')
    console.error('这通常意味着程序**没跑起来** —— 看 ' + path.join(DATA_DIR, 'pet.log'))
    console.error('注意：单实例锁被占、被杀毒软件拦、或构建产物损坏都会是这个现象。')
    process.exit(1)
  }
  console.log('')
  console.log(report.trim())
  const failed = /失败 ([1-9]\d*)/.exec(report)
  process.exit(failed || code !== 0 ? 1 : 0)
})
