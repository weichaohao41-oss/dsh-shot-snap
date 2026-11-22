# dsh-shot-snap · 截图即插入

给 DeepSeek Harness 对话窗口加一个截图按钮：**点一下 → 拖拽框选 → 标注 → 截图自动进当前输入框附件区**，
不用开微信/QQ 截图、不用存文件、不用手动上传。

```sh
dsh plugin add dsh-shot-snap
# 或在「插件 → 发现 / 插件市场」里搜 shot-snap 一键安装
```

> In one line: press the button next to the composer (or `Ctrl + Shift + S`), drag a region on your
> screen, mark it up with arrows and boxes, and the crop lands in the current chat's attachment tray
> as a normal image — nothing is uploaded anywhere else, and nothing is ever sent for you.

- **纯本地**：截图只在本机内存里走一趟，不联网、不上传第三方；
- **不自动发送**：截图只进输入框，发不发、配什么文字由你决定；
- **快捷键可配置**：默认 `Ctrl + Shift + S`，在「设置 → 通用 → 快捷键」里随时改，冲突由宿主检测；
- **不改宿主行为**：按钮塞在输入框工具行左侧，走宿主自己的附件入口，原有输入/发送/上传/快捷键都不动。

## 用法

| 操作 | 结果 |
| --- | --- |
| 点输入框左侧的「截图」按钮 | 冻结画面，进入框选模式 |
| 点按钮右侧小三角 | 打开菜单：切换截图范围、修改/清除/恢复快捷键 |
| `Ctrl + Shift + S` | 同「点按钮」（可在设置里改） |
| 拖拽鼠标框选 | 实时显示像素尺寸，松手后出现操作条 |
| 工具条：矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字 | 在选区上标注，5 色 × 3 档粗细 |
| 拖动已画的标注 | 移动标注位置（按住 `Shift` 锁定水平或垂直） |
| `Ctrl + Z` | 撤销上一步（含拖动） |
| `Enter` / 「插入输入框」 | 选区（含标注）裁成 PNG，插入当前会话的输入框附件区 |
| 选区为空时按 `Enter` | 整张画面插入 |
| `Esc` / 「取消」 / 「重画」 | 取消本次截图 / 重新框选 |

### 截图范围

菜单里可以选两种：

- **整个桌面**（默认）：点按钮后窗口先临时铺满屏幕（像 QQ / Snipaste 那样整屏冻结），
  再隐藏一瞬抓整块桌面，抓完窗口回到原位、画面铺满屏幕给你框选，
  所以 Edge、微信、IDE 等其它软件都能截进来；选完（插入 / 取消 / 出错）窗口自动复原；
- **当前窗口**：只截 DSH 窗口自己的内容区，不闪烁、也没有其它窗口干扰。

选择保存在本机 `localStorage`（键 `dsh-shot-snap.capture-mode`），下次沿用。

插入成功后输入框底部出现缩略图，可像普通附件一样删除；**不会自动发送**。

### 快捷键

默认 `Ctrl + Shift + S`（macOS 上 `Cmd + Shift + S`）。改法有两个，效果一致：

- 点按钮右边的小三角 → 「修改快捷键」→ 按下新的组合键（Esc 取消）；
- 「设置 → 通用 → 快捷键」里搜「截图」。

键位由宿主的快捷键中心管理：冲突会当场提示，改完写进宿主的键位配置并在下次启动时保留。
插件内部另外自带一个兜底监听，所以桌面端（Electron）即使原生键盘桥没把按键送进来，也能触发截图。

## 实现方式

两个半片，都是 DSH 标准插件形态：

- **Host 半片**（`index.js`）：`ctx.webServer` 注册 `/_dsh/shotsnap/capture`。
  Electron 桌面窗口没有 `setDisplayMediaRequestHandler`，窗口内 `getDisplayMedia()` 用不了，
  所以由宿主进程调 `powershell.exe` 做一次 `System.Drawing.CopyFromScreen`（先声明 DPI 感知，
  150% 缩放下也是物理像素、不糊），把 PNG 直接回给本机页面，不落盘。
  - `?desktop=1`：先 `ShowWindow(SW_HIDE)` 隐藏本应用窗口 → 抓整块虚拟桌面 → `SW_RESTORE` + `SetForegroundWindow` 恢复，
    PowerShell 超时被杀时 Node 侧还会再补救一次恢复窗口，避免窗口一直藏着；
  - 带 `x/y/w/h`：只裁窗口视口的物理像素矩形（「当前窗口」模式用）；
  - `/window/expand`、`/window/restore`：整屏模式下临时把窗口铺满屏幕、选完复原（记住原矩形，
    另有 60 秒看门狗兜底复原，防止浏览器半片异常时窗口卡在全屏尺寸）；
  - `/ping`（自检）、`/log`（调试日志），全部只监听本机 `127.0.0.1` 上宿主自己的端口。
- **浏览器半片**（`client.js`）：
  - `conversation.input.left` —— 输入框工具行左侧的截图按钮（图标 + 下拉小三角）；
  - `shell.overlay` —— 全屏框选遮罩（portal 到 `document.body`，z-index 置顶），显示冻结帧、拖拽选区、
    尺寸提示、标注画布、操作条、Toast；截图期间给 `<html>` 加 `shotsnap-active` 类，
    临时关掉宿主的 `-webkit-app-region: drag`，避免点屏幕顶部变成拖窗口；
  - `ctx.shortcuts.register({ id: 'shot.capture', ... })` —— 快捷键交给宿主快捷键中心，
    于是「可配置 / 冲突检测 / 持久化 / 快捷键速查」全部复用宿主能力；
  - 插入走**合成 paste 事件**：把选区裁成 `File` 塞进 `DataTransfer`，`document.dispatchEvent(new ClipboardEvent('paste', ...))`，
    交给宿主 composer 自己的文件入口（`createComposerFileIntake`），
    这样宿主的图片校验、张数上限、上传、草稿逻辑全部生效，插件不碰任何私有 API，也不会触发发送。

## 权限与隐私

- 只申请实现功能所必需的权限：宿主自己的 HTTP 路由（本机 127.0.0.1）+ 一次本地 PowerShell 抓屏；
- 不读剪贴板、不读其他插件的 DOM、不采集对话内容；
- 截图字节只存在于本机内存（浏览器 Blob）与宿主临时文件（`%TEMP%\dsh-shot-<随机>.png`，读完立即删除）；
- 调试日志 `%TEMP%\dsh-shot-snap.log` 只记录插件自身动作（抓屏耗时、选区尺寸、是否插入成功），
  不含画面内容与对话内容，超过约 256 KB 自动截断，可随时删除；
- 宿主路由做了跨站防护：带 `Sec-Fetch-Site: cross-site` 的请求直接 403，别的网站没法调它静默截屏。

## 常见问题

**按钮没出现？** 插件装好后需刷新窗口（`Ctrl + R`）；仍没有就看 `%TEMP%\dsh-shot-snap.log` 里有没有 `plugin.ready`。

**截图是黑屏/花屏？** 少数全屏独占游戏或受保护窗口（DRM 播放器）无法被 `CopyFromScreen` 抓到，属于系统限制。

**插入失败提示「当前输入框接不了附件」？** 通常是在生成回复中、或该会话已锁定；等回复结束再试。

**快捷键没反应？** 到「设置 → 通用 → 快捷键」搜索「截图」，确认没被其他命令占用（冲突会标红）；
若仍未触发，点按钮小三角 →「恢复默认」重设一次。

**多显示器？** 整屏模式抓的是整块虚拟桌面（所有显示器拼接的范围），框选时跨屏也能拖。

**高 DPI？** 抓图先声明 DPI 感知，输出物理像素，150% / 200% 缩放下也不糊。

## 开发

```sh
# 本地软链安装（改完代码后把 bundle 关掉再打开即可热更新）
dsh plugin add link:C:\path\to\shot-snap-plugin
```

- `index.js`：Host 半片（抓屏路由 + 窗口铺屏/复原）；
- `client.js`：浏览器半片（按钮、遮罩、标注、快捷键）；
- `cordis.patch.yml`：bundle 的 patch 行（`insert: shot-snap`）；
- `icon.svg`：插件图标。

调试：`%TEMP%\dsh-shot-snap.log`，每行一个事件（`plugin.ready` / `capture.start` / `capture.ready` /
`select` / `annotate.add` / `insert.dispatch` / `insert.done` / `shortcut.saved` …）。

## 卸载

插件管理里卸载 `dsh-shot-snap` 即可；卸载时按钮、遮罩、快捷键命令一并移除，输入框回到原样。

## License

MIT
