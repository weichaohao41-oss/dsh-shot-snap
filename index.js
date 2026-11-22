// dsh-shot-snap — Host 半片
//
// 职责：给浏览器半片提供「把当前屏幕截成 PNG」的本地 HTTP 路由。
// 为什么走宿主：Electron 桌面窗口没有 setDisplayMediaRequestHandler，
// getDisplayMedia() 在窗口内不可用；宿主进程可以调系统级抓屏。
// 约束：只在用户主动触发的请求里抓屏；图片只回给本机 127.0.0.1 的页面，不落盘、不外传。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 浏览器半片用的路由前缀 */
const ROUTE_PREFIX = '/_dsh/shotsnap'
/** 抓屏超时（毫秒） */
const CAPTURE_TIMEOUT_MS = 15000
/** 调试日志：只记录插件自身动作，不含任何对话内容 */
const LOG_FILE = path.join(os.tmpdir(), 'dsh-shot-snap.log')
/** 单次日志请求上限 */
const MAX_LOG_BYTES = 64 * 1024
/** 日志文件超过这个大小就清空重来，避免长期使用无限增长 */
const MAX_LOG_FILE_BYTES = 256 * 1024

// 抓屏脚本：先声明 DPI 感知（否则 150% 缩放下会抓到模糊的缩放图），再整屏 CopyFromScreen。
// 传了 W/H 就裁到指定物理像素矩形（浏览器半片只截它自己的窗口视口，框选才对得上画面）。
// 传了 HideName 则先把窗口临时隐藏、抓完立刻恢复 —— 这样「截整个桌面」时别的软件才露得出来。
// 只有虚拟屏矩形与 PNG 编码，不读窗口内容、不联网。
const PS_SCRIPT = String.raw`param([string]$Out, [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0, [string]$HideName = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShotsnapDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
public static class ShotsnapWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
try { [void][ShotsnapDpi]::SetProcessDPIAware() } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$hwnd = [IntPtr]::Zero
if ($HideName -ne '') {
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like $HideName } | Select-Object -First 1
  if ($null -eq $proc) {
    $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*DeepSeek Harness*' } | Select-Object -First 1
  }
  if ($null -ne $proc) {
    $hwnd = $proc.MainWindowHandle
    try { [void][ShotsnapWin]::ShowWindow($hwnd, 0) } catch { $hwnd = [IntPtr]::Zero }
    # 等窗口真的消失、桌面重绘完成，否则会抓到残影
    if ($hwnd -ne [IntPtr]::Zero) { Start-Sleep -Milliseconds 220 }
  }
}

try {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bmp.Size) } finally { $g.Dispose() }
  try {
    if ($W -gt 0 -and $H -gt 0) {
      $left = [Math]::Max(0, $X - $screen.Left)
      $top = [Math]::Max(0, $Y - $screen.Top)
      $right = [Math]::Min($screen.Width, ($X - $screen.Left) + $W)
      $bottom = [Math]::Min($screen.Height, ($Y - $screen.Top) + $H)
      $cw = $right - $left
      $ch = $bottom - $top
      if ($cw -lt 8 -or $ch -lt 8) { throw "crop rect outside virtual screen" }
      $rect = New-Object System.Drawing.Rectangle $left, $top, $cw, $ch
      $crop = $bmp.Clone($rect, $bmp.PixelFormat)
      try { $crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $crop.Dispose() }
      Write-Output ("{0}x{1}" -f $cw, $ch)
    } else {
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ("{0}x{1}" -f $screen.Width, $screen.Height)
    }
  } finally { $bmp.Dispose() }
} finally {
  if ($hwnd -ne [IntPtr]::Zero) {
    try { [void][ShotsnapWin]::ShowWindow($hwnd, 9) } catch {}
    Start-Sleep -Milliseconds 60
    try { [void][ShotsnapWin]::SetForegroundWindow($hwnd) } catch {}
  }
}
`

// 窗口铺满屏幕 / 复原：截图时把 DSH 窗口临时拉成整屏，冻结帧才能铺满屏幕、框选边界和真实屏幕对得上；
// 选完（或取消、出错）立刻按原样复原。只读写窗口位置大小，不碰内容。
const WINDOW_SCRIPT = String.raw`param([string]$Action = 'expand', [string]$Rect = '', [string]$Owner = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct ShotsnapRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class ShotsnapWindow {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out ShotsnapRect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][ShotsnapWindow]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like $Owner } | Select-Object -First 1
if ($null -eq $proc) {
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*DeepSeek Harness*' } | Select-Object -First 1
}
if ($null -eq $proc) { Write-Error 'window not found'; exit 2 }
$hwnd = $proc.MainWindowHandle
if ($Action -eq 'expand') {
  # 先确保窗口是「可见且非最大化」状态，否则 GetWindowRect 拿到的是最小化时的 -32000 占位矩形
  $zoomed = 0
  if ([ShotsnapWindow]::IsIconic($hwnd)) { [void][ShotsnapWindow]::ShowWindow($hwnd, 9); Start-Sleep -Milliseconds 140 }
  if ([ShotsnapWindow]::IsZoomed($hwnd)) { $zoomed = 1; [void][ShotsnapWindow]::ShowWindow($hwnd, 9); Start-Sleep -Milliseconds 140 }
  $r = New-Object ShotsnapRect
  [void][ShotsnapWindow]::GetWindowRect($hwnd, [ref]$r)
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  # SWP_SHOWWINDOW(0x40) | SWP_NOACTIVATE(0x10)
  [void][ShotsnapWindow]::SetWindowPos($hwnd, [IntPtr]::Zero, $screen.Left, $screen.Top, $screen.Width, $screen.Height, 0x50)
  [void][ShotsnapWindow]::SetForegroundWindow($hwnd)
  Write-Output ("{0},{1},{2},{3},{4}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), $zoomed)
} elseif ($Action -eq 'restore') {
  $parts = $Rect.Split(',')
  if ($parts.Length -lt 5) { Write-Error 'bad rect'; exit 3 }
  $x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
  $zoomed = [int]$parts[4]
  [void][ShotsnapWindow]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $w, $h, 0x40)
  if ($zoomed -eq 1) { [void][ShotsnapWindow]::ShowWindow($hwnd, 3) }
  Start-Sleep -Milliseconds 60
  [void][ShotsnapWindow]::SetForegroundWindow($hwnd)
  Write-Output 'ok'
}
`

/** 把窗口脚本落到临时目录（只写一次） */
let windowScriptReady = null
function ensureWindowScript() {
  if (windowScriptReady) return windowScriptReady
  windowScriptReady = (async () => {
    const file = path.join(os.tmpdir(), 'dsh-shot-snap-window.ps1')
    await fs.writeFile(file, WINDOW_SCRIPT.replace(/\r?\n/g, '\r\n'), 'utf8')
    return file
  })().catch((error) => {
    windowScriptReady = null
    throw error
  })
  return windowScriptReady
}

/** 跑窗口脚本（expand 返回 "x,y,w,h,zoomed"；restore 返回 "ok"） */
async function runWindowScript(action, rect) {
  const script = await ensureWindowScript()
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action]
  if (rect) args.push('-Rect', rect)
  args.push('-Owner', appProcessName())
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error(`窗口脚本超时（${action}）`))
    }, 10000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`窗口脚本退出码 ${code}${stderr ? '：' + stderr.trim().slice(0, 300) : ''}`))
    })
  })
}

// 记住铺屏前的窗口矩形，任何意外都要能复原（含看门狗定时器）
let expandedRect = null
let restoreTimer = null

async function expandWindow() {
  if (expandedRect) return expandedRect
  const rect = (await runWindowScript('expand')).split(/\r?\n/).pop() || ''
  if (!/^-?\d+,-?\d+,\d+,\d+,[01]$/.test(rect)) throw new Error(`窗口铺屏失败：${rect.slice(0, 120)}`)
  expandedRect = rect
  if (restoreTimer) clearTimeout(restoreTimer)
  // 看门狗：万一浏览器半片没回来复原（崩溃/关页面），60 秒后自动复原
  restoreTimer = setTimeout(() => { void restoreExpandedWindow('watchdog') }, 60000)
  if (typeof restoreTimer.unref === 'function') restoreTimer.unref()
  await appendLog(`window.expand ${rect}`)
  return rect
}

async function restoreExpandedWindow(reason = 'client') {
  if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null }
  if (!expandedRect) return false
  const rect = expandedRect
  expandedRect = null
  try {
    await runWindowScript('restore', rect)
    await appendLog(`window.restore ${reason}`)
    return true
  } catch (error) {
    await appendLog(`window.restore.fail ${reason} ${error?.message || String(error)}`)
    return false
  }
}

let scriptReady = null

/** 把抓屏脚本落到临时目录（只写一次） */
function ensureScript() {
  if (scriptReady) return scriptReady
  scriptReady = (async () => {
    const file = path.join(os.tmpdir(), 'dsh-shot-snap-capture.ps1')
    await fs.writeFile(file, PS_SCRIPT.replace(/\r?\n/g, '\r\n'), 'utf8')
    return file
  })().catch((error) => {
    scriptReady = null
    throw error
  })
  return scriptReady
}

/** 从 PNG 的 IHDR 里读宽高 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 本应用的进程名（整屏截图时用来临时隐藏自己的窗口），从当前可执行文件推断 */
function appProcessName() {
  try {
    const base = path.basename(process.execPath || '', '.exe')
    if (base && base.toLowerCase() !== 'node') return base
  } catch {}
  // 兜底：脚本里还会按窗口标题再找一次，这里给个宽松的名字
  return 'DeepSeek Harness'
}

/** 万一副本超时被杀，尽力把窗口恢复回来（避免窗口一直藏着） */
function restoreWindow(name) {
  if (!name) return
  const command = `$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ShotsnapRestore { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }
'@
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like '${name.replace(/'/g, "''")}' } | Select-Object -First 1
if ($null -ne $p) { [void][ShotsnapRestore]::ShowWindow($p.MainWindowHandle, 9) }`
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => {})
  } catch {}
}

/** 调用 PowerShell 抓一次整屏（可给物理像素矩形裁剪到窗口视口；hideName 非空则先藏窗口再抓） */
async function captureScreen(options = {}) {
  const { rect = null, hideName = '' } = options
  const started = Date.now()
  const script = await ensureScript()
  const out = path.join(os.tmpdir(), `dsh-shot-${started}-${Math.random().toString(36).slice(2, 8)}.png`)
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', out]
  if (rect) args.push('-X', String(rect.x), '-Y', String(rect.y), '-W', String(rect.w), '-H', String(rect.h))
  if (hideName) args.push('-HideName', hideName)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', args, { windowsHide: true })
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        restoreWindow(hideName)
        reject(new Error(`抓屏超时（${CAPTURE_TIMEOUT_MS}ms）`))
      }, CAPTURE_TIMEOUT_MS)
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`抓屏脚本退出码 ${code}${stderr ? '：' + stderr.trim().slice(0, 400) : ''}`))
      })
    })
    const buffer = await fs.readFile(out)
    if (buffer.length < 1024) throw new Error(`抓屏结果异常（${buffer.length} 字节）`)
    const size = pngSize(buffer)
    return { buffer, size, ms: Date.now() - started }
  } finally {
    await fs.unlink(out).catch(() => {})
  }
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_LOG_BYTES) throw new Error('日志过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 记录浏览器半片的调试事件（插件自身动作，不含对话内容） */
async function appendLog(line) {
  const entry = `${new Date().toISOString()} ${line}\n`
  try {
    const info = await fs.stat(LOG_FILE).catch(() => null)
    if (info && info.size > MAX_LOG_FILE_BYTES) await fs.writeFile(LOG_FILE, '', 'utf8')
    await fs.appendFile(LOG_FILE, entry, 'utf8')
  } catch {
    // 日志失败不影响功能
  }
}

export function logFilePath() {
  return LOG_FILE
}

/** 依赖 webServer：宿主没有这个服务时不激活，面板照常工作 */
export const inject = ['webServer']

export function apply(ctx) {
  const web = ctx.get('webServer')
  if (!web) return
  ctx.effect(
    () =>
      web.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            // 只服务本机页面：别的网站发起的抓屏请求直接拒掉，避免被网页静默截屏
            const site = req.headers['sec-fetch-site']
            if (typeof site === 'string' && site === 'cross-site') {
              sendJson(res, 403, { ok: false, error: '拒绝跨站截图请求' })
              return
            }
            const url = new URL(req.url, 'http://127.0.0.1')
            const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
            if (action === 'window/expand') {
              try {
                const rect = await expandWindow()
                sendJson(res, 200, { ok: true, rect })
              } catch (error) {
                const message = error?.message || String(error)
                await appendLog(`window.expand.fail ${message}`)
                sendJson(res, 500, { ok: false, error: message })
              }
              return
            }
            if (action === 'window/restore') {
              const restored = await restoreExpandedWindow('client')
              sendJson(res, 200, { ok: true, restored })
              return
            }
            if (action === 'capture') {
              // desktop=1：整屏截图，先把本应用窗口临时藏起来，别的软件才露得出来
              const desktop = url.searchParams.get('desktop') === '1'
              // 否则浏览器半片会带上自己窗口视口的物理像素矩形，只截那块，框选画面才和屏幕一致
              const num = (name) => {
                const raw = url.searchParams.get(name)
                const value = raw === null ? NaN : Number(raw)
                return Number.isFinite(value) ? Math.round(value) : NaN
              }
              const x = num('x'), y = num('y'), w = num('w'), h = num('h')
              const rect = [x, y, w, h].every((value) => Number.isFinite(value)) && w > 0 && h > 0
                ? { x, y, w, h }
                : null
              try {
                const shot = await captureScreen({
                  rect: desktop ? null : rect,
                  hideName: desktop ? appProcessName() : '',
                })
                res.writeHead(200, {
                  'Content-Type': 'image/png',
                  'Content-Length': shot.buffer.length,
                  'Cache-Control': 'no-store',
                  'X-Shot-Width': String(shot.size.width),
                  'X-Shot-Height': String(shot.size.height),
                  'X-Shot-Ms': String(shot.ms),
                  'X-Shot-Mode': desktop ? 'desktop' : 'window',
                  'X-Shot-Cropped': !desktop && rect ? '1' : '0',
                })
                res.end(shot.buffer)
                await appendLog(`capture ok ${shot.size.width}x${shot.size.height} ${shot.buffer.length}B ${shot.ms}ms${desktop ? ' desktop' : rect ? ' cropped' : ' full'}`)
              } catch (error) {
                const message = error?.message || String(error)
                await appendLog(`capture fail ${message}`)
                sendJson(res, 500, { ok: false, error: message })
              }
              return
            }
            if (action === 'log' && req.method === 'POST') {
              const text = await readBody(req)
              const line = text.trim().slice(0, MAX_LOG_BYTES)
              if (line) await appendLog(`client ${line}`)
              sendJson(res, 200, { ok: true })
              return
            }
            if (action === 'graph') {
              // 诊断用：确认本插件的浏览器半片是否已进入宿主的 web boot graph
              const modules = ctx.get('clientModules')
              let graph = null
              try {
                graph = modules && typeof modules.graph === 'function' ? modules.graph() : null
              } catch (error) {
                graph = { error: error?.message || String(error) }
              }
              sendJson(res, 200, { ok: true, hasService: Boolean(modules), graph })
              return
            }
            if (action === 'ping') {
              sendJson(res, 200, { ok: true, plugin: 'dsh-shot-snap', log: LOG_FILE })
              return
            }
            sendJson(res, 404, { ok: false, error: `unknown endpoint: ${action}` })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error?.message || String(error) })
          }
        },
      }),
    'dsh-shot-snap: http routes',
  )
}

/* 加载器读的是 default 导出（与 dsh-case-studio 一致）：{ inject, apply } */
export default { inject, apply }
