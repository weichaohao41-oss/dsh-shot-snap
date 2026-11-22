/**
 * dsh-shot-snap · 浏览器半片
 *
 * 四件事：
 *   ① 输入框工具行左侧放一个「截图」按钮 + 快捷键下拉菜单（可改键位）；
 *   ② 打开全屏遮罩，显示宿主刚抓好的冻结帧（只截本窗口视口），拖拽框选；
 *   ③ 框选后可像微信截图一样标注：矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字，支持撤销；
 *   ④ 把带标注的选区导出成 PNG，通过合成 paste 事件交给宿主 composer 自己的附件入口。
 *
 * 约束：纯本地（图片只在本机内存里走一趟）；必须用户主动触发；插入后绝不自动发送；
 *      不改动宿主原有输入、发送、附件、快捷键逻辑（走的是宿主公开的 slot / shortcuts / paste intake）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-shot-snap',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    // 浮层要 portal 到 body，才能盖住宿主自己的标题栏（否则最上面一条会变成拖窗口的区域）
    let createPortal = null;
    try {
      const reactDom = require('react-dom');
      createPortal = reactDom && reactDom.createPortal ? reactDom.createPortal : null;
    } catch {}

    /** Host 半片提供的抓屏路由前缀 */
    const ROUTE = '/_dsh/shotsnap';
    /** 宿主快捷键命令 id */
    const COMMAND = 'shot.capture';
    /** 调试日志前缀 */
    const TAG = '[dsh-shot-snap]';
    /** 选中区域最小边长（CSS 像素），小于它视为误触 */
    const MIN_SELECTION = 4;
    /** 等宿主处理 paste 的最长时间 */
    const INSERT_WAIT_MS = 2000;
    /** 默认键位（也用于「恢复默认」提示） */
    const DEFAULT_BINDING = { code: 'KeyS', modifiers: ['primary', 'shift'] };

    /** 标注颜色（与微信截图相近的常用五种） */
    const COLORS = ['#FF3B30', '#FFB800', '#0A84FF', '#34C759', '#FFFFFF'];
    /** 笔画粗细（CSS 像素） */
    const WIDTHS = [
      { label: '细', value: 3 },
      { label: '中', value: 6 },
      { label: '粗', value: 11 },
    ];
    /** 标注工具 */
    const TOOLS = [
      { key: 'rect', label: '矩形' },
      { key: 'ellipse', label: '椭圆' },
      { key: 'arrow', label: '箭头' },
      { key: 'pen', label: '画笔' },
      { key: 'mosaic', label: '马赛克' },
      { key: 'text', label: '文字' },
    ];

    // 最早的生命信号：模块一执行就先落一条日志。
    // 这样即使后面装配失败（或宿主根本没加载这个 bundle），也能从日志区分「没加载」和「加载了但报错」。
    try {
      void fetch(`${ROUTE}/log`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: 'module.exec',
        keepalive: true,
      }).catch(() => {});
    } catch {}

    /* ============================== 样式 ============================== */

    const CSS = `
.shotsnap-split{display:inline-flex;align-items:center;flex:0 0 auto}
.shotsnap-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto;transition:background .12s ease,color .12s ease}
.shotsnap-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.shotsnap-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.shotsnap-btn:active{transform:scale(.96)}
.shotsnap-btn[data-busy="1"]{opacity:.45;cursor:progress}
.shotsnap-caret{display:inline-flex;align-items:center;justify-content:center;width:14px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:.7}
.shotsnap-caret:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);opacity:1}
.shotsnap-caret:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.shotsnap-menu-backdrop{position:fixed;inset:0;z-index:2147483002;background:transparent}
.shotsnap-menu{position:fixed;z-index:2147483003;width:248px;display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:10px;background:rgba(24,24,27,.98);border:1px solid rgba(255,255,255,.14);box-shadow:0 14px 34px rgba(0,0,0,.45);color:#f2f4f8;font:12px/1.5 "Microsoft YaHei",system-ui,sans-serif}
.shotsnap-menu-title{color:rgba(255,255,255,.55);font-size:11px}
.shotsnap-menu-keys{font:600 15px/1.4 "Consolas",monospace;color:#fff;letter-spacing:.5px}
.shotsnap-menu-keys[data-none="1"]{color:rgba(255,255,255,.42);font-weight:400}
.shotsnap-menu-record{padding:6px 8px;border-radius:7px;background:rgba(59,130,246,.16);border:1px dashed rgba(120,170,255,.7);color:#cfe1ff;font-size:11px}
.shotsnap-menu-row{display:flex;gap:6px;flex-wrap:wrap}
.shotsnap-menu-btn{flex:1 1 auto;padding:6px 9px;border:0;border-radius:7px;background:rgba(255,255,255,.1);color:#f2f4f8;font:inherit;cursor:pointer;white-space:nowrap}
.shotsnap-menu-btn[data-active="1"]{background:rgba(255,255,255,.24);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28)}
.shotsnap-menu-btn:hover{background:rgba(255,255,255,.18)}
.shotsnap-menu-btn[data-primary="1"]{background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff}
.shotsnap-menu-err{color:#ffb4b4;font-size:11px}
.shotsnap-menu-hint{color:rgba(255,255,255,.45);font-size:11px;line-height:1.45}
.shotsnap-layer{position:fixed;inset:0;z-index:2147483647;pointer-events:auto;cursor:crosshair;overflow:hidden;user-select:none;-webkit-user-select:none;touch-action:none}
/* 截图期间屏蔽宿主的「窗口可拖动」区域：否则点屏幕最上边会变成拖动窗口，而不是开始框选 */
html.shotsnap-active,html.shotsnap-active body,html.shotsnap-active body *{-webkit-app-region:no-drag !important}
.shotsnap-dim{position:absolute;inset:0;background:rgba(10,10,12,.38);pointer-events:none}
.shotsnap-shot{position:absolute;pointer-events:none;user-select:none;-webkit-user-drag:none}
.shotsnap-sel{position:absolute;border:1px solid rgba(255,255,255,.85);box-shadow:0 0 0 100vmax rgba(10,10,12,.55);pointer-events:none}
.shotsnap-canvas{position:absolute;pointer-events:auto;touch-action:none;cursor:crosshair}
.shotsnap-hint{position:absolute;left:50%;top:16px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:7px 14px;border-radius:999px;background:rgba(24,24,27,.9);color:#fff;font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.32);pointer-events:none;white-space:nowrap}
.shotsnap-hint b{font-weight:600;color:#8fc0ff}
.shotsnap-size{position:absolute;padding:2px 7px;border-radius:6px;background:rgba(24,24,27,.92);color:#fff;font:11px/1.5 "Consolas",monospace;pointer-events:none;white-space:nowrap}
.shotsnap-tools{position:absolute;z-index:5;display:flex;flex-direction:column;gap:5px;padding:6px;border-radius:10px;background:rgba(24,24,27,.95);border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 28px rgba(0,0,0,.4);font:12px/1.3 "Microsoft YaHei",system-ui,sans-serif}
.shotsnap-tools-row{display:flex;align-items:center;gap:3px;flex-wrap:wrap}
.shotsnap-tools-hint{padding:0 3px 1px;color:rgba(255,255,255,.45);font-size:11px;line-height:1.3}
.shotsnap-act{display:inline-flex;align-items:center;gap:4px;padding:5px 8px;border:0;border-radius:7px;background:transparent;color:#f2f4f8;font:inherit;cursor:pointer;white-space:nowrap}
.shotsnap-act:hover{background:rgba(255,255,255,.12)}
.shotsnap-act[data-active="1"]{background:rgba(255,255,255,.2);color:#fff}
.shotsnap-act[data-primary="1"]{background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff}
.shotsnap-act[data-primary="1"]:hover{filter:brightness(1.08)}
.shotsnap-act[data-disabled="1"]{opacity:.4;cursor:default}
.shotsnap-keys{margin-left:2px;color:rgba(255,255,255,.5);font-size:11px}
.shotsnap-divider{width:1px;height:18px;background:rgba(255,255,255,.16);margin:0 2px}
.shotsnap-swatch{width:16px;height:16px;padding:0;border:1px solid rgba(255,255,255,.4);border-radius:50%;cursor:pointer}
.shotsnap-swatch[data-active="1"]{box-shadow:0 0 0 2px rgba(255,255,255,.8)}
.shotsnap-width{min-width:26px;padding:3px 5px;border:0;border-radius:6px;background:rgba(255,255,255,.1);color:#f2f4f8;font:inherit;cursor:pointer}
.shotsnap-width[data-active="1"]{background:rgba(255,255,255,.28);color:#fff}
.shotsnap-textinput{position:absolute;z-index:6;min-width:90px;padding:1px 4px;border:1px dashed rgba(255,255,255,.85);border-radius:3px;background:rgba(0,0,0,.35);outline:none;font-weight:600;font-family:"Microsoft YaHei",system-ui,sans-serif;line-height:1.25}
.shotsnap-toast{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:2147483004;display:flex;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;background:rgba(24,24,27,.95);color:#fff;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.36);pointer-events:none;max-width:min(560px,82vw)}
.shotsnap-toast[data-kind="error"]{background:rgba(176,42,42,.96)}
.shotsnap-toast[data-kind="warn"]{background:rgba(158,110,20,.96)}
`;

    /* ============================== 运行时状态 ============================== */

    /**
     * 全局状态：phase = idle | capturing | ready
     * 用一份可变对象 + 订阅者，让按钮、快捷键菜单、遮罩三个独立 slot 条目共享同一状态。
     */
    const modeKey = 'dsh-shot-snap.capture-mode';

    /** 截图范围：desktop = 整个桌面所有窗口（截图时临时把 DSH 窗口藏起来）；window = 只截 DSH 本窗口 */
    function readCaptureMode() {
      try {
        const saved = window.localStorage.getItem(modeKey);
        if (saved === 'window' || saved === 'desktop') return saved;
      } catch {}
      return 'desktop';
    }

    function saveCaptureMode(mode) {
      try {
        window.localStorage.setItem(modeKey, mode);
      } catch {}
      emit({ mode });
      logEvent('capture.mode', { mode });
    }

    const state = {
      phase: 'idle',
      mode: readCaptureMode(),
      src: '',
      natW: 0,
      natH: 0,
      frame: null,
      error: '',
      toast: null,
      toastSeq: 0,
      menu: null,
    };
    const subscribers = new Set();

    /** 合并状态并通知所有订阅者 */
    function emit(patch) {
      Object.assign(state, patch);
      for (const fn of Array.from(subscribers)) {
        try {
          fn();
        } catch (error) {
          console.error(TAG, 'listener failed', error);
        }
      }
    }

    function subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }

    /** 订阅全局状态的 React hook */
    function useShotState() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      useEffect(() => subscribe(force), []);
      return state;
    }

    /** 订阅宿主 ObservableSnapshot（例如 shortcuts.catalog） */
    function useObservable(observable) {
      const read = useCallback(
        () => (observable && typeof observable.getSnapshot === 'function' ? observable.getSnapshot() : null),
        [observable],
      );
      const [value, setValue] = useState(read);
      useEffect(() => {
        setValue(read());
        if (!observable || typeof observable.subscribe !== 'function') return undefined;
        return observable.subscribe(() => setValue(read()));
      }, [observable, read]);
      return value;
    }

    /** 输入框附件数探针：由按钮组件把 useInput 的数量写进来，用于确认插入是否生效 */
    const probe = { count: -1 };

    function showToast(text, kind) {
      state.toastSeq += 1;
      emit({ toast: { text, kind: kind || 'ok', seq: state.toastSeq } });
    }

    /** 把插件自身动作写进宿主日志文件（不含对话内容），方便没有 DevTools 时排查 */
    function logEvent(event, extra) {
      const line = { event, ...(extra || {}) };
      try {
        console.log(TAG, event, extra || '');
      } catch {}
      try {
        void fetch(`${ROUTE}/log`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(line),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    }

    /* ============================== 截图采集 ============================== */

    /**
     * 本窗口「内容区」在屏幕上的物理像素矩形。
     * 只截这块，冻结帧才和用户眼前的画面严丝合缝，框选/标注的坐标才对得上。
     * 拿不到窗口几何时返回 null，退回整屏抓图（显示时按 contain 居中）。
     */
    function viewportRect() {
      try {
        const dpr = window.devicePixelRatio || 1;
        const outerW = window.outerWidth;
        const outerH = window.outerHeight;
        const innerW = window.innerWidth;
        const innerH = window.innerHeight;
        if (!(outerW > 0 && outerH > 0 && innerW > 0 && innerH > 0 && dpr > 0)) return null;
        const borderX = Math.max(0, Math.round((outerW - innerW) / 2));
        const chromeTop = Math.max(0, Math.round(outerH - innerH - borderX));
        const x = Math.round((window.screenX + borderX) * dpr);
        const y = Math.round((window.screenY + chromeTop) * dpr);
        const w = Math.round(innerW * dpr);
        const h = Math.round(innerH * dpr);
        if (w < 32 || h < 32) return null;
        return { x, y, w, h, dpr };
      } catch (_error) {
        return null;
      }
    }

    function releaseFrame() {
      if (state.src) {
        try {
          URL.revokeObjectURL(state.src);
        } catch {}
      }
    }

    /** 关闭遮罩并释放冻结帧 */
    function closeOverlay() {
      releaseFrame();
      emit({ phase: 'idle', src: '', natW: 0, natH: 0, frame: null });
      restoreWindowAfterShot();
    }

    /** 整屏模式：先把窗口临时铺满屏幕，冻结帧才能铺满、框选边界和真实屏幕对得上 */
    let windowExpanded = false;
    async function expandWindowForShot() {
      if (windowExpanded) return true;
      try {
        const response = await fetch(`${ROUTE}/window/expand`, { cache: 'no-store' });
        if (!response.ok) {
          logEvent('window.expand.skip', { status: response.status });
          return false;
        }
        windowExpanded = true;
        return true;
      } catch (error) {
        logEvent('window.expand.skip', { error: String((error && error.message) || error) });
        return false;
      }
    }

    /** 复原窗口大小位置（无论成功、取消还是出错都要调用） */
    function restoreWindowAfterShot() {
      if (!windowExpanded) return;
      windowExpanded = false;
      fetch(`${ROUTE}/window/restore`, { cache: 'no-store' })
        .then(() => logEvent('window.restore.client'))
        .catch(() => {});
    }

    function decodeImage(url) {
      const image = new Image();
      image.src = url;
      return typeof image.decode === 'function'
        ? image.decode().then(() => image)
        : new Promise((resolve, reject) => {
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('截图解码失败'));
          });
    }

    /** 用户主动触发：向宿主请求一帧截图（优先只截本窗口视口），成功后打开框选遮罩 */
    async function startCapture() {
      if (state.phase === 'capturing') return;
      if (state.phase === 'ready') {
        closeOverlay();
        return;
      }
      if (state.menu) closeMenu();
      emit({ phase: 'capturing', error: '' });
      logEvent('capture.start');
      const startedAt = Date.now();
      try {
        // desktop 模式：宿主先把 DSH 自己的窗口临时藏起来，再抓整块桌面，这样别的软件才露得出来；
        // window 模式：只截本窗口视口，抓完直接按物理像素裁好。
        const desktop = state.mode === 'desktop';
        logEvent('capture.mode', { mode: state.mode });
        let cropped = false;
        let response = null;
        if (desktop) {
          // 先把窗口铺满屏幕（像 QQ 截图那样整屏冻结），再让宿主藏起窗口抓整块桌面
          await expandWindowForShot();
          response = await fetch(`${ROUTE}/capture?desktop=1`, { cache: 'no-store' });
          if (!response.ok) {
            logEvent('capture.desktop.fallback', { status: response.status });
            response = null;
          }
        } else {
          const rect = viewportRect();
          if (rect) {
            const query = new URLSearchParams({
              x: String(rect.x),
              y: String(rect.y),
              w: String(rect.w),
              h: String(rect.h),
            });
            response = await fetch(`${ROUTE}/capture?${query}`, { cache: 'no-store' });
            if (response.ok) {
              cropped = true;
            } else {
              logEvent('capture.crop.fallback', { status: response.status });
              response = null;
            }
          }
        }
        if (!response) response = await fetch(`${ROUTE}/capture`, { cache: 'no-store' });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
        }
        const blob = await response.blob();
        if (!blob || blob.size < 512) throw new Error('截图数据为空');
        const url = URL.createObjectURL(blob);
        let image = null;
        try {
          image = await decodeImage(url);
        } catch (error) {
          URL.revokeObjectURL(url);
          throw error;
        }
        if (!image.naturalWidth || !image.naturalHeight) {
          URL.revokeObjectURL(url);
          throw new Error('截图尺寸异常');
        }
        releaseFrame();
        emit({
          phase: 'ready',
          src: url,
          natW: image.naturalWidth,
          natH: image.naturalHeight,
          frame: image,
          error: '',
        });
        logEvent('capture.ready', {
          width: image.naturalWidth,
          height: image.naturalHeight,
          bytes: blob.size,
          ms: Date.now() - startedAt,
          mode: desktop ? 'desktop' : 'window',
          cropped,
        });
      } catch (error) {
        const message = (error && error.message) || String(error);
        emit({ phase: 'idle', error: message });
        showToast(`截图失败：${message}`, 'error');
        logEvent('capture.fail', { error: message });
        restoreWindowAfterShot();
      }
    }

    /* ============================== 几何与绘制 ============================== */

    /**
     * 冻结帧在视口里的显示几何。
     * scaleX/scaleY = 图片像素 / CSS 像素，用来在「视口坐标」和「图片坐标」之间换算。
     */
    function geometry(natW, natH) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const contain = natW > 0 && natH > 0 ? Math.min(vw / natW, vh / natH) : 1;
      const width = natW * contain;
      const height = natH * contain;
      return {
        vw,
        vh,
        left: (vw - width) / 2,
        top: (vh - height) / 2,
        width,
        height,
        scaleX: width > 0 ? natW / width : 1,
        scaleY: height > 0 ? natH / height : 1,
      };
    }

    /** 把冻结帧里选中的那块画进离屏 canvas（物理像素，作为标注底板） */
    function makeBase(image, geom, selection) {
      if (!image || !selection) return null;
      const width = Math.max(1, Math.round(selection.w * geom.scaleX));
      const height = Math.max(1, Math.round(selection.h * geom.scaleY));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const sx = (selection.x - geom.left) * geom.scaleX;
      const sy = (selection.y - geom.top) * geom.scaleY;
      const sw = selection.w * geom.scaleX;
      const sh = selection.h * geom.scaleY;
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
      return canvas;
    }

    /** 画一个标注形状（坐标系是选区内的 CSS 像素，马赛克单独换算到物理像素） */
    function paintShape(ctx, shape, geom, base) {
      if (!shape) return;
      if (shape.tool === 'mosaic') {
        if (!base) return;
        const px = Math.round(shape.x * geom.scaleX);
        const py = Math.round(shape.y * geom.scaleY);
        const pw = Math.round(shape.w * geom.scaleX);
        const ph = Math.round(shape.h * geom.scaleY);
        if (pw < 3 || ph < 3) return;
        const blocks = 14;
        const tw = Math.max(1, Math.round(pw / blocks));
        const th = Math.max(1, Math.round(ph / blocks));
        const tiny = document.createElement('canvas');
        tiny.width = tw;
        tiny.height = th;
        const tctx = tiny.getContext('2d');
        if (!tctx) return;
        tctx.imageSmoothingEnabled = false;
        tctx.drawImage(base, px, py, pw, ph, 0, 0, tw, th);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tiny, 0, 0, tw, th, px, py, pw, ph);
        ctx.imageSmoothingEnabled = true;
        ctx.restore();
        return;
      }
      ctx.save();
      ctx.strokeStyle = shape.color;
      ctx.fillStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (shape.tool === 'pen') {
        const points = shape.points || [];
        if (points.length === 1) {
          ctx.beginPath();
          ctx.arc(points[0][0], points[0][1], Math.max(0.6, shape.width / 2), 0, Math.PI * 2);
          ctx.fill();
        } else if (points.length > 1) {
          ctx.beginPath();
          ctx.moveTo(points[0][0], points[0][1]);
          for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
          ctx.stroke();
        }
      } else if (shape.tool === 'rect') {
        ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      } else if (shape.tool === 'ellipse') {
        const rx = Math.abs(shape.w) / 2;
        const ry = Math.abs(shape.h) / 2;
        if (rx > 0.5 && ry > 0.5) {
          ctx.beginPath();
          ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (shape.tool === 'arrow') {
        const dx = shape.x2 - shape.x1;
        const dy = shape.y2 - shape.y1;
        const length = Math.hypot(dx, dy);
        if (length >= 1) {
          const angle = Math.atan2(dy, dx);
          const head = Math.max(10, shape.width * 2.4);
          ctx.beginPath();
          ctx.moveTo(shape.x1, shape.y1);
          ctx.lineTo(shape.x2, shape.y2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(shape.x2, shape.y2);
          ctx.lineTo(shape.x2 - head * Math.cos(angle - Math.PI / 7), shape.y2 - head * Math.sin(angle - Math.PI / 7));
          ctx.moveTo(shape.x2, shape.y2);
          ctx.lineTo(shape.x2 - head * Math.cos(angle + Math.PI / 7), shape.y2 - head * Math.sin(angle + Math.PI / 7));
          ctx.stroke();
        }
      } else if (shape.tool === 'text') {
        ctx.font = `600 ${shape.size}px "Microsoft YaHei", system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(shape.text, shape.x, shape.y);
      }
      ctx.restore();
    }

    /** 拖拽出来的两点 → 归一化矩形 */
    function rectBetween(a, b) {
      return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x),
        h: Math.abs(a.y - b.y),
      };
    }

    function stamp() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * 把图片交给宿主输入框：合成 paste 事件走宿主自己的 composer 文件入口。
     * 这样复用宿主的图片校验 / 上传 / 草稿逻辑，插件不碰私有 API，也不会自动发送。
     */
    async function insertImage(blob) {
      const name = `screenshot-${stamp()}.png`;
      const before = probe.count;
      let handled = false;
      try {
        const file = new File([blob], name, { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const event = new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        document.dispatchEvent(event);
        handled = event.defaultPrevented;
      } catch (error) {
        showToast(`插入失败：${(error && error.message) || error}`, 'error');
        logEvent('insert.crash', { error: String((error && error.message) || error) });
        return;
      }
      logEvent('insert.dispatch', { name, bytes: blob.size, handled, before });
      if (!handled) {
        showToast('当前输入框接不了附件（可能正在生成回复或会话已锁定），请稍后再试', 'warn');
        return;
      }
      // 宿主的插入是异步的：等附件数变化，确认真的进去了
      let after = before;
      const deadline = Date.now() + INSERT_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(100);
        after = probe.count;
        if (before >= 0 && after > before) break;
      }
      logEvent('insert.done', { name, before, after });
      if (before >= 0 && after <= before) {
        showToast('截图已交给输入框，但没检测到新附件，请确认一下', 'warn');
        return;
      }
      showToast('截图已插入输入框，检查无误后再发送', 'ok');
    }

    /* ============================== 图标 ============================== */

    function CaptureIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3.5 8.5V6A2.5 2.5 0 0 1 6 3.5h2.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M15.5 3.5H18A2.5 2.5 0 0 1 20.5 6v2.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M20.5 15.5V18a2.5 2.5 0 0 1-2.5 2.5h-2.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M8.5 20.5H6A2.5 2.5 0 0 1 3.5 18v-2.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.7 }),
      );
    }

    function CaretIcon() {
      return h(
        'svg',
        { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M6 9.5 12 15.5 18 9.5', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    /* ============================== 输入区按钮 + 快捷键菜单 ============================== */

    /** 从宿主快捷键目录里取这个命令的当前键位 */
    function readKeys(catalog) {
      if (!Array.isArray(catalog)) return [];
      const entry = catalog.find((row) => row && row.id === COMMAND);
      return entry && Array.isArray(entry.keys) ? entry.keys : [];
    }

    /** 从宿主快捷键目录里取这个命令的当前绑定（{ code, secondCode?, modifiers }） */
    function readBinding(catalog) {
      if (!Array.isArray(catalog)) return null;
      const entry = catalog.find((row) => row && row.id === COMMAND);
      return entry && entry.binding ? entry.binding : null;
    }

    /** 宿主给的 keys 数组在 Windows 上会夹着 '+' 分隔符，拼成「Ctrl+Shift+S」这种可读文本 */
    function joinKeys(keys) {
      if (!Array.isArray(keys) || !keys.length) return '';
      return keys.filter((part) => part !== '+').join('+');
    }

    /**
     * 宿主的快捷键目录（ObservableSnapshot）。桌面端的原生键盘层只转发它自己同步过的命令，
     * 插件注册的自定义绑定在那边不一定被派发，所以自己要按同一份目录再匹配一次。
     */
    let hotkeyCatalog = null;

    /** 当前生效的绑定（以宿主目录为准 → 用户改完键位立刻生效） */
    function currentBinding() {
      const catalog = hotkeyCatalog && typeof hotkeyCatalog.getSnapshot === 'function'
        ? hotkeyCatalog.getSnapshot()
        : null;
      return readBinding(catalog);
    }

    /** 一次 keydown 是否命中当前绑定：物理 code 相同，且修饰键完全一致 */
    function matchesBinding(event, binding) {
      if (!binding || typeof binding.code !== 'string' || !binding.code) return false;
      if (event.code !== binding.code) return false;
      const want = { control: false, alt: false, shift: false, meta: false };
      if (Array.isArray(binding.modifiers)) {
        for (const modifier of binding.modifiers) if (modifier in want) want[modifier] = true;
      }
      return event.ctrlKey === want.control
        && event.altKey === want.alt
        && event.shiftKey === want.shift
        && event.metaKey === want.meta;
    }

    /** 事件是否发生在输入类元素里（文本框 / contenteditable） */
    function inEditable(event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const node of path) {
        if (!node || node.nodeType !== 1) continue;
        const tag = String(node.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        const editable = node.getAttribute && node.getAttribute('contenteditable');
        if (editable !== null && editable !== 'false') return true;
      }
      return false;
    }

    /** 事件是否发生在截图遮罩内部（遮罩自己处理 Esc/Enter/打字） */
    function insideOverlay(event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      return path.some((node) => node && node.classList && node.classList.contains('shotsnap-layer'));
    }

    /** 快捷键触发入口：与按钮走同一条路径 */
    function triggerCapture(reason) {
      if (state.phase === 'capturing') return;
      if (state.phase === 'ready') {
        logEvent('cancel', { reason });
        closeOverlay();
        return;
      }
      logEvent('hotkey.fire', { reason });
      void startCapture();
    }

    /** 打开快捷键下拉菜单（贴着箭头按钮下方，空间不够就翻到上方） */
    function openMenu(anchor) {
      const width = 248;
      const height = 268;
      const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8);
      const below = anchor.bottom + 6;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below;
      emit({ menu: { x: left, y: top, recording: false, note: '', error: '' } });
      logEvent('menu.open');
    }

    function closeMenu() {
      if (state.menu && state.menu.recording) {
        // 退出录制时恢复宿主原生菜单快捷键
        try {
          if (menuApi && typeof menuApi.recording === 'function') void Promise.resolve(menuApi.recording(false)).catch(() => {});
        } catch {}
      }
      if (state.menu) emit({ menu: null });
    }

    /** 快捷键服务实例（由按钮组件写入，供菜单逻辑使用） */
    let menuApi = null;

    /** 菜单收尾：解除录制态（否则宿主原生菜单加速键会一直被抑制）并关掉菜单 */
    function finishMenu() {
      try {
        if (menuApi && typeof menuApi.recording === 'function') {
          void Promise.resolve(menuApi.recording(false)).catch(() => {});
        }
      } catch {}
      if (state.menu) emit({ menu: null });
    }

    function updateMenu(patch) {
      if (!state.menu) return;
      emit({ menu: { ...state.menu, ...patch } });
    }

    /** 保存新键位：先后查一遍宿主给的可用性/冲突结论，再落盘 */
    async function applyBinding(binding) {
      if (!menuApi) return;
      try {
        const described = menuApi.describeBinding(binding);
        if (described && described.issue) {
          updateMenu({ error: `这个组合键宿主不支持（${described.issue}）` });
          return;
        }
        if (described && described.conflicts && described.conflicts.length) {
          updateMenu({ error: `和这些命令撞了：${described.conflicts.join('、')}` });
          return;
        }
        const snapshot = menuApi.config.getSnapshot();
        const result = await menuApi.edit({ type: 'set', id: COMMAND, binding }, snapshot.revision);
        if (result && result.status === 'saved') {
          const keys = (described && described.keys) || [];
          finishMenu();
          showToast(`截图快捷键已设为 ${joinKeys(keys) || '自定义组合'}`, 'ok');
          logEvent('shortcut.saved', { code: binding.code, modifiers: binding.modifiers, keys: keys.join('+') });
          return;
        }
        if (result && result.status === 'conflict') {
          updateMenu({ error: '这个组合键和别的命令冲突，换一个试试' });
        } else {
          updateMenu({ error: `保存失败（${(result && result.status) || 'unknown'}）` });
        }
        logEvent('shortcut.fail', { status: result && result.status });
      } catch (error) {
        updateMenu({ error: String((error && error.message) || error) });
        logEvent('shortcut.crash', { error: String((error && error.message) || error) });
      }
    }

    /** 清除绑定 */
    async function clearBinding() {
      if (!menuApi) return;
      try {
        const snapshot = menuApi.config.getSnapshot();
        const result = await menuApi.edit({ type: 'set', id: COMMAND, binding: null }, snapshot.revision);
        if (result && result.status === 'saved') {
          finishMenu();
          showToast('已清除截图快捷键，仍可用按钮截图', 'warn');
          logEvent('shortcut.cleared');
        } else {
          updateMenu({ error: `保存失败（${(result && result.status) || 'unknown'}）` });
        }
      } catch (error) {
        updateMenu({ error: String((error && error.message) || error) });
      }
    }

    /** 恢复宿主默认键位 */
    async function resetBinding() {
      if (!menuApi) return;
      try {
        const snapshot = menuApi.config.getSnapshot();
        const result = await menuApi.edit({ type: 'reset', id: COMMAND }, snapshot.revision);
        if (result && result.status === 'saved') {
          finishMenu();
          showToast('已恢复默认快捷键', 'ok');
          logEvent('shortcut.reset');
        } else {
          updateMenu({ error: `保存失败（${(result && result.status) || 'unknown'}）` });
        }
      } catch (error) {
        updateMenu({ error: String((error && error.message) || error) });
      }
    }

    /** 进入录制态：等用户按下组合键 */
    function startRecording() {
      updateMenu({ recording: true, note: '', error: '' });
      try {
        if (menuApi && typeof menuApi.recording === 'function') {
          void Promise.resolve(menuApi.recording(true)).catch((error) => {
            logEvent('shortcut.recording.fail', { error: String((error && error.message) || error) });
          });
        }
      } catch {}
      logEvent('shortcut.recording');
    }

    function ShotButton(props) {
      const shot = useShotState();
      const catalog = useObservable(props.shortcuts && props.shortcuts.catalog);
      // 只订阅附件数量，避免草稿每敲一个字都重渲染
      const attachments = props.useInput
        ? props.useInput((snapshot) => (snapshot && Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds.length : -1))
        : -1;
      probe.count = typeof attachments === 'number' ? attachments : -1;
      menuApi = props.shortcuts || null;

      const keys = readKeys(catalog);
      const busy = shot.phase === 'capturing';
      const title = keys.length ? `截图并插入输入框（${joinKeys(keys)}）` : '截图并插入输入框';

      return h(
        'div',
        { className: 'shotsnap-split' },
        h(
          'button',
          {
            type: 'button',
            className: 'shotsnap-btn',
            title,
            'aria-label': title,
            'data-busy': busy ? '1' : '0',
            onClick: () => {
              closeMenu();
              void startCapture();
            },
          },
          h(CaptureIcon, { size: 16 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'shotsnap-caret',
            title: '截图快捷键设置',
            'aria-label': '截图快捷键设置',
            'aria-haspopup': 'menu',
            onClick: (event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              if (state.menu) {
                closeMenu();
                return;
              }
              openMenu({ top: rect.top, bottom: rect.bottom, right: rect.right, left: rect.left });
            },
          },
          h(CaretIcon, null),
        ),
      );
    }

    /** 快捷键下拉菜单（挂在 shell.overlay 里，避免被输入区容器裁切） */
    function ShortcutMenu(props) {
      const shot = useShotState();
      const catalog = useObservable(props.shortcuts && props.shortcuts.catalog);
      const menu = shot.menu;
      menuApi = props.shortcuts || menuApi;

      const recording = Boolean(menu && menu.recording);

      // 录制态：拦截按键，把物理键 + 修饰键翻译成宿主 binding
      useEffect(() => {
        if (!recording) return undefined;
        const onKeyDown = (event) => {
          if (event.target && typeof event.target.tagName === 'string' && event.target.tagName === 'INPUT') return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') {
            updateMenu({ recording: false, note: '已取消' });
            try {
              if (menuApi && typeof menuApi.recording === 'function') void Promise.resolve(menuApi.recording(false)).catch(() => {});
            } catch {}
            return;
          }
          const code = event.code;
          if (!code || /^(Control|Shift|Alt|Meta|OS|CapsLock|ContextMenu)(Left|Right)?$/.test(code)) return;
          const modifiers = [];
          if (event.ctrlKey || event.metaKey) modifiers.push('primary');
          if (event.altKey) modifiers.push('alt');
          if (event.shiftKey) modifiers.push('shift');
          if (!modifiers.length) {
            updateMenu({ error: '至少要带 Ctrl / Alt / Shift 中的一个' });
            return;
          }
          void applyBinding({ code, modifiers });
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [recording]);

      // 菜单打开时按 Esc 关闭
      useEffect(() => {
        if (!menu) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          if (state.menu && state.menu.recording) {
            updateMenu({ recording: false, note: '已取消' });
          } else {
            closeMenu();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [Boolean(menu)]);

      if (!menu) return null;
      const keys = readKeys(catalog);

      const node = h(
        React.Fragment,
        null,
        h('div', { className: 'shotsnap-menu-backdrop', onPointerDown: () => closeMenu() }),
        h(
          'div',
          {
            className: 'shotsnap-menu',
            style: { left: `${menu.x}px`, top: `${menu.y}px` },
            onPointerDown: (event) => event.stopPropagation(),
          },
          h('div', { className: 'shotsnap-menu-title' }, '截图范围'),
          h(
            'div',
            { className: 'shotsnap-menu-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'shotsnap-menu-btn',
                'data-active': shot.mode === 'desktop' ? '1' : '0',
                onClick: () => saveCaptureMode('desktop'),
              },
              '整个桌面',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'shotsnap-menu-btn',
                'data-active': shot.mode === 'window' ? '1' : '0',
                onClick: () => saveCaptureMode('window'),
              },
              '当前窗口',
            ),
          ),
          h(
            'div',
            { className: 'shotsnap-menu-hint' },
            shot.mode === 'desktop'
              ? '整屏截图：窗口会先铺满屏幕、再隐藏一瞬抓整块桌面，回来就能框选任何软件。'
              : '只截 DSH 窗口内容，框选边界和画面完全对齐。',
          ),
          h('div', { className: 'shotsnap-menu-title' }, '截图快捷键'),
          h(
            'div',
            { className: 'shotsnap-menu-keys', 'data-none': keys.length ? '0' : '1' },
            keys.length ? joinKeys(keys) : '未设置',
          ),
          recording
            ? h('div', { className: 'shotsnap-menu-record' }, '按下新的组合键…（Esc 取消）')
            : menu.note
              ? h('div', { className: 'shotsnap-menu-hint' }, menu.note)
              : null,
          menu.error ? h('div', { className: 'shotsnap-menu-err' }, menu.error) : null,
          recording
            ? null
            : h(
                'div',
                { className: 'shotsnap-menu-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'shotsnap-menu-btn',
                    'data-primary': '1',
                    onClick: () => startRecording(),
                  },
                  '修改快捷键',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'shotsnap-menu-btn',
                    onClick: () => void clearBinding(),
                  },
                  '清除',
                ),
              ),
          h(
            'div',
            { className: 'shotsnap-menu-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'shotsnap-menu-btn',
                onClick: () => void resetBinding(),
              },
              '恢复默认',
            ),
          ),
          h('div', { className: 'shotsnap-menu-hint' }, '也可以到「设置 → 通用 → 快捷键」里统一修改，键位会随账号配置保存。'),
          h('div', { className: 'shotsnap-menu-hint' }, '建议带上 Ctrl 或 Alt：只有字符键时，在输入框里打字会误触发截图。'),
        ),
      );
      // 菜单同样 portal 到 body：输入区附近容器的层级会把它裁掉
      if (createPortal) {
        try {
          return createPortal(node, document.body);
        } catch {}
      }
      return node;
    }

    /* ============================== 框选遮罩 + 标注 ============================== */

    /** 单行文字的宽度估算（命中测试用，不必像素级精确） */
    function textWidth(text, size) {
      let width = 0;
      for (const char of String(text || '')) {
        width += char.charCodeAt(0) > 0x2e80 ? size : size * 0.58;
      }
      return width;
    }

    /** 标注的包围盒（选区局部 CSS 坐标） */
    function shapeBounds(shape) {
      if (!shape) return null;
      if (shape.tool === 'pen') {
        const points = shape.points || [];
        if (!points.length) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [x, y] of points) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
        const pad = Math.max(4, (shape.width || 3) / 2);
        return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
      }
      if (shape.tool === 'arrow') {
        const pad = Math.max(6, (shape.width || 3) * 2);
        return {
          x: Math.min(shape.x1, shape.x2) - pad,
          y: Math.min(shape.y1, shape.y2) - pad,
          w: Math.abs(shape.x2 - shape.x1) + pad * 2,
          h: Math.abs(shape.y2 - shape.y1) + pad * 2,
        };
      }
      if (shape.tool === 'text') {
        const size = shape.size || 16;
        return { x: shape.x, y: shape.y, w: Math.max(size, textWidth(shape.text, size)), h: size * 1.35 };
      }
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    }

    /** 平移一个标注（拖动时复用） */
    function translateShape(shape, dx, dy) {
      if (shape.tool === 'pen') {
        return { ...shape, points: (shape.points || []).map(([x, y]) => [x + dx, y + dy]) };
      }
      if (shape.tool === 'arrow') {
        return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
      }
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    }

    /** 命中测试：从最上层（最后画的）往下找，返回索引；-1 表示没命中 */
    function hitShape(shapes, point, tolerance) {
      for (let index = shapes.length - 1; index >= 0; index -= 1) {
        const bounds = shapeBounds(shapes[index]);
        if (!bounds) continue;
        if (
          point.x >= bounds.x - tolerance
          && point.x <= bounds.x + bounds.w + tolerance
          && point.y >= bounds.y - tolerance
          && point.y <= bounds.y + bounds.h + tolerance
        ) {
          return index;
        }
      }
      return -1;
    }

    function ShotOverlay() {
      const shot = useShotState();
      const [drag, setDrag] = useState(null);
      const [selection, setSelection] = useState(null);
      const [tool, setTool] = useState('rect');
      const [color, setColor] = useState(COLORS[0]);
      const [width, setWidth] = useState(WIDTHS[1].value);
      const [shapes, setShapes] = useState([]);
      const [draft, setDraft] = useState(null);
      const [textDraft, setTextDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [, bumpViewport] = React.useReducer((x) => x + 1, 0);
      const canvasRef = useRef(null);
      const textRef = useRef(null);
      /** 正在拖动的标注（pointerdown 命中已画内容时置位） */
      const moveRef = useRef(null);
      /** 撤销历史：整份 shapes 快照，这样「移动」也能撤销 */
      const historyRef = useRef([]);
      /** shapes 的镜像，给事件回调读最新值 */
      const shapesRef = useRef(shapes);
      shapesRef.current = shapes;

      const ready = shot.phase === 'ready';
      const geom = geometry(shot.natW, shot.natH);

      // 换阶段时复位选区与标注
      useEffect(() => {
        setDrag(null);
        setSelection(null);
        setShapes([]);
        setDraft(null);
        setTextDraft(null);
        setSaving(false);
        moveRef.current = null;
        historyRef.current = [];
      }, [shot.phase]);

      // 窗口尺寸变化时重算几何
      useEffect(() => {
        if (!ready) return undefined;
        const onResize = () => bumpViewport();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [ready]);

      // 卸载时释放冻结帧
      useEffect(() => () => releaseFrame(), []);

      // 截图期间给 <html> 打标记：CSS 里据此关掉宿主的窗口拖拽区域
      useEffect(() => {
        const active = shot.phase !== 'idle';
        document.documentElement.classList.toggle('shotsnap-active', active);
        return () => document.documentElement.classList.remove('shotsnap-active');
      }, [shot.phase]);

      // 提示气泡定时消失
      const toast = shot.toast;
      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => {
          if (state.toast && state.toast.seq === toast.seq) emit({ toast: null });
        }, 3400);
        return () => clearTimeout(timer);
      }, [toast && toast.seq]);

      const toastNode = toast
        ? h('div', { className: 'shotsnap-toast', 'data-kind': toast.kind }, toast.text)
        : null;

      // 标注底板：选中区域对应的物理像素图像
      const base = React.useMemo(
        () => (ready && selection ? makeBase(shot.frame, geom, selection) : null),
        [ready, selection, shot.frame, geom.left, geom.top, geom.scaleX, geom.scaleY],
      );

      const selectionSig = selection ? `${Math.round(selection.w)}x${Math.round(selection.h)}` : '';

      // 重画：底板 + 所有标注 + 草稿
      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !selection) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (base) ctx.drawImage(base, 0, 0);
        ctx.setTransform(geom.scaleX, 0, 0, geom.scaleY, 0, 0);
        for (const shape of shapes) paintShape(ctx, shape, geom, base);
        paintShape(ctx, draft, geom, base);
      }, [base, shapes, draft, selection, selectionSig, geom.scaleX, geom.scaleY]);

      // 文字输入框挂载后自动聚焦
      useEffect(() => {
        if (textDraft && textRef.current) {
          textRef.current.focus();
          textRef.current.select();
        }
      }, [Boolean(textDraft)]);

      const clampLocal = useCallback(
        (x, y) => {
          const sel = selection;
          if (!sel) return { x: 0, y: 0 };
          return {
            x: Math.min(Math.max(x, 0), sel.w),
            y: Math.min(Math.max(y, 0), sel.h),
          };
        },
        [selection],
      );

      const localPoint = useCallback((event) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        return clampLocal(event.clientX - rect.left, event.clientY - rect.top);
      }, [clampLocal]);

      const commitShape = useCallback((shape) => {
        if (!shape) return;
        historyRef.current.push(shapesRef.current);
        if (historyRef.current.length > 80) historyRef.current.shift();
        setShapes((prev) => [...prev, shape]);
        logEvent('annotate.add', { tool: shape.tool });
      }, []);

      /** 命中已画内容的判定容差（CSS 像素） */
      const hitTolerance = Math.max(6, width + 3);

      // 指针：先看是不是按在已有的标注上（拖动移动），否则开始画新的
      const onCanvasDown = (event) => {
        if (event.button !== 0 || saving || !selection) return;
        event.preventDefault();
        const point = localPoint(event);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {}
        if (!textDraft) {
          const index = hitShape(shapesRef.current, point, hitTolerance);
          if (index >= 0) {
            moveRef.current = {
              index,
              start: point,
              original: shapesRef.current[index],
              before: shapesRef.current,
              moved: false,
            };
            event.currentTarget.style.cursor = 'grabbing';
            return;
          }
        }
        if (tool === 'text') {
          setTextDraft({ x: point.x, y: point.y, value: '' });
          return;
        }
        if (tool === 'pen') {
          setDraft({ tool: 'pen', color, width, points: [[point.x, point.y], [point.x, point.y]] });
          return;
        }
        if (tool === 'arrow') {
          setDraft({ tool: 'arrow', color, width, x1: point.x, y1: point.y, x2: point.x, y2: point.y });
          return;
        }
        setDraft({ tool, color, width, x: point.x, y: point.y, w: 0, h: 0 });
      };

      const onCanvasMove = (event) => {
        const point = localPoint(event);

        // 拖动已有标注
        const move = moveRef.current;
        if (move) {
          let dx = point.x - move.start.x;
          let dy = point.y - move.start.y;
          if (event.shiftKey) {
            if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          const bounds = shapeBounds(move.original);
          const limitW = selection ? selection.w : 0;
          const limitH = selection ? selection.h : 0;
          if (bounds) {
            dx = Math.min(Math.max(dx, -bounds.x), limitW - (bounds.x + bounds.w));
            dy = Math.min(Math.max(dy, -bounds.y), limitH - (bounds.y + bounds.h));
          }
          if (dx !== 0 || dy !== 0) move.moved = true;
          const movedShape = translateShape(move.original, dx, dy);
          setShapes(move.before.map((shape, index) => (index === move.index ? movedShape : shape)));
          return;
        }

        if (!draft) {
          // 悬停在已画内容上显示「可拖动」光标
          const hover = hitShape(shapesRef.current, point, hitTolerance) >= 0;
          const next = hover ? 'move' : 'crosshair';
          if (event.currentTarget.style.cursor !== next) event.currentTarget.style.cursor = next;
          return;
        }

        if (draft.tool === 'pen') {
          const points = draft.points.slice();
          const last = points[points.length - 1];
          if (Math.hypot(point.x - last[0], point.y - last[1]) < 1.5) return;
          points.push([point.x, point.y]);
          setDraft({ ...draft, points });
          return;
        }
        if (draft.tool === 'arrow') {
          setDraft({ ...draft, x2: point.x, y2: point.y });
          return;
        }
        const box = rectBetween({ x: draft.x, y: draft.y }, point);
        setDraft({ ...draft, x: box.x, y: box.y, w: box.w, h: box.h });
      };

      const onCanvasUp = () => {
        const move = moveRef.current;
        if (move) {
          moveRef.current = null;
          if (move.moved) {
            historyRef.current.push(move.before);
            if (historyRef.current.length > 80) historyRef.current.shift();
            logEvent('annotate.move', { tool: move.original.tool, index: move.index });
          } else {
            setShapes(move.before);
          }
          return;
        }
        if (!draft) return;
        const shape = draft;
        setDraft(null);
        if (shape.tool === 'pen') {
          if ((shape.points || []).length >= 2) commitShape(shape);
          return;
        }
        if (shape.tool === 'arrow') {
          if (Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) >= 8) commitShape(shape);
          return;
        }
        if (shape.w >= 4 && shape.h >= 4) commitShape(shape);
      };

      const commitText = useCallback(() => {
        if (!textDraft) return;
        const value = textDraft.value.trim();
        const position = { x: textDraft.x, y: textDraft.y };
        setTextDraft(null);
        if (!value) return;
        commitShape({
          tool: 'text',
          color,
          size: Math.max(12, Math.round(width * 4)),
          x: position.x,
          y: position.y,
          text: value,
        });
      }, [textDraft, color, width, commitShape]);

      const undo = useCallback(() => {
        const previous = historyRef.current.pop();
        if (previous) {
          setShapes(previous);
          logEvent('annotate.undo', { restored: true });
          return;
        }
        setShapes((prev) => (prev.length ? prev.slice(0, -1) : prev));
        logEvent('annotate.undo');
      }, []);

      /** 导出当前画布（含标注）并插入输入框 */
      const finalize = useCallback(async () => {
        const canvas = canvasRef.current;
        if (!canvas || saving || !selection) return;
        setSaving(true);
        try {
          const blob = await new Promise((resolve, reject) => {
            canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('图片编码失败'))), 'image/png');
          });
          logEvent('crop', {
            width: canvas.width,
            height: canvas.height,
            bytes: blob.size,
            shapes: shapes.length,
          });
          closeOverlay();
          setSaving(false);
          await insertImage(blob);
        } catch (error) {
          setSaving(false);
          const message = (error && error.message) || String(error);
          showToast(`截图处理失败：${message}`, 'error');
          logEvent('crop.fail', { error: message });
        }
      }, [saving, selection, shapes]);

      /** 没有选区时：整窗插入 */
      const wholeViewport = useCallback(async () => {
        if (saving || !state.src) return;
        setSaving(true);
        try {
          const response = await fetch(state.src);
          const blob = await response.blob();
          closeOverlay();
          setSaving(false);
          await insertImage(blob);
        } catch (error) {
          setSaving(false);
          showToast(`整窗插入失败：${(error && error.message) || error}`, 'error');
        }
      }, [saving]);

      // 键盘：Esc 取消 / Enter 插入 / Ctrl+Z 撤销
      useEffect(() => {
        if (!ready) return undefined;
        const onKeyDown = (event) => {
          // 快捷键菜单打开时由菜单自己处理键盘，别把截图一起关掉
          if (state.menu) return;
          if (textDraft) {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setTextDraft(null);
            }
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            logEvent('cancel', { reason: 'escape' });
            closeOverlay();
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (selection) void finalize();
            else void wholeViewport();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            event.stopPropagation();
            undo();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [ready, selection, finalize, wholeViewport, undo, Boolean(textDraft)]);

      /* ---------- 渲染 ---------- */

      const nodes = [];
      if (ready) {
        nodes.push(
          h('img', {
            key: 'frame',
            className: 'shotsnap-shot',
            src: shot.src,
            alt: '',
            draggable: false,
            style: {
              left: `${geom.left}px`,
              top: `${geom.top}px`,
              width: `${geom.width}px`,
              height: `${geom.height}px`,
            },
          }),
        );
      }

      const rect = drag ? rectBetween(drag.a, drag.b) : selection;
      const hasRect = rect && rect.w >= MIN_SELECTION && rect.h >= MIN_SELECTION;
      const dimOutside = hasRect;

      if (ready && hasRect) {
        nodes.push(
          h('div', {
            key: 'sel',
            className: 'shotsnap-sel',
            style: { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` },
          }),
        );
        const labelLeft = Math.min(Math.max(4, rect.x + 6), geom.vw - 92);
        const labelTop = rect.y > 26 ? rect.y - 24 : rect.y + 6;
        nodes.push(
          h(
            'div',
            { key: 'size', className: 'shotsnap-size', style: { left: `${labelLeft}px`, top: `${labelTop}px` } },
            `${Math.round(rect.w * geom.scaleX)} × ${Math.round(rect.h * geom.scaleY)}`,
          ),
        );
      }

      // 标注画布：只盖住选区
      if (ready && selection) {
        nodes.push(
          h('canvas', {
            key: 'canvas',
            ref: canvasRef,
            className: 'shotsnap-canvas',
            width: Math.max(1, Math.round(selection.w * geom.scaleX)),
            height: Math.max(1, Math.round(selection.h * geom.scaleY)),
            style: {
              left: `${selection.x}px`,
              top: `${selection.y}px`,
              width: `${selection.w}px`,
              height: `${selection.h}px`,
            },
            onPointerDown: onCanvasDown,
            onPointerMove: onCanvasMove,
            onPointerUp: onCanvasUp,
            onPointerCancel: onCanvasUp,
          }),
        );
      }

      // 文字输入框
      if (ready && selection && textDraft) {
        nodes.push(
          h('input', {
            key: 'text',
            ref: textRef,
            className: 'shotsnap-textinput',
            style: {
              left: `${selection.x + textDraft.x}px`,
              top: `${selection.y + textDraft.y}px`,
              color,
              caretColor: color,
              fontSize: `${Math.max(12, Math.round(width * 4))}px`,
            },
            value: textDraft.value,
            placeholder: '输入文字，Enter 确认',
            onChange: (event) => setTextDraft({ ...textDraft, value: event.target.value }),
            onKeyDown: (event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitText();
              }
            },
            onBlur: () => commitText(),
          }),
        );
      }

      if (ready && !hasRect) {
        nodes.push(
          h(
            'div',
            { key: 'hint', className: 'shotsnap-hint' },
            h('span', null, '拖拽框选区域'),
            h('b', null, 'Enter'),
            h('span', null, '整窗插入'),
            h('b', null, 'Esc'),
            h('span', null, '取消'),
          ),
        );
      }

      // 标注工具条：贴着选区上方，空间不够放下方
      if (ready && selection && !drag) {
        const barWidth = 424;
        const barHeight = 102;
        const left = Math.min(Math.max(8, selection.x), Math.max(8, geom.vw - barWidth - 8));
        const top = selection.y - barHeight - 8 >= 8
          ? selection.y - barHeight - 8
          : Math.min(geom.vh - barHeight - 8, selection.y + selection.h + 8);
        nodes.push(
          h(
            'div',
            { key: 'tools', className: 'shotsnap-tools', style: { left: `${left}px`, top: `${top}px` } },
            h(
              'div',
              { className: 'shotsnap-tools-row' },
              ...TOOLS.map((item) =>
                h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    className: 'shotsnap-act',
                    'data-active': tool === item.key ? '1' : '0',
                    onClick: () => {
                      if (textDraft) commitText();
                      setTool(item.key);
                    },
                  },
                  item.label,
                ),
              ),
              h('span', { className: 'shotsnap-divider' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'shotsnap-act',
                  'data-disabled': shapes.length ? '0' : '1',
                  title: '撤销（Ctrl + Z）',
                  onClick: () => {
                    if (shapes.length) undo();
                  },
                },
                '撤销',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'shotsnap-act',
                  title: '重新框选',
                  onClick: () => {
                    setSelection(null);
                    setShapes([]);
                    setDraft(null);
                    setTextDraft(null);
                    historyRef.current = [];
                    moveRef.current = null;
                  },
                },
                '重画',
              ),
            ),
            h(
              'div',
              { className: 'shotsnap-tools-row' },
              ...COLORS.map((value) =>
                h('button', {
                  key: value,
                  type: 'button',
                  className: 'shotsnap-swatch',
                  title: `颜色 ${value}`,
                  style: { background: value },
                  'data-active': color === value ? '1' : '0',
                  onClick: () => setColor(value),
                }),
              ),
              h('span', { className: 'shotsnap-divider' }),
              ...WIDTHS.map((item) =>
                h(
                  'button',
                  {
                    key: item.label,
                    type: 'button',
                    className: 'shotsnap-width',
                    'data-active': width === item.value ? '1' : '0',
                    onClick: () => setWidth(item.value),
                  },
                  item.label,
                ),
              ),
              h('span', { className: 'shotsnap-divider' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'shotsnap-act',
                  'data-primary': '1',
                  onClick: () => void finalize(),
                },
                '插入输入框',
                h('span', { className: 'shotsnap-keys' }, 'Enter'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'shotsnap-act',
                  onClick: () => {
                    logEvent('cancel', { reason: 'button' });
                    closeOverlay();
                  },
                },
                '取消',
                h('span', { className: 'shotsnap-keys' }, 'Esc'),
              ),
            ),
            h('div', { className: 'shotsnap-tools-hint' }, '拖动已画的标注可换位置（按住 Shift 锁定方向）'),
          ),
        );
      }

      const layer = ready
        ? h(
            'div',
            {
              key: 'layer',
              className: 'shotsnap-layer',
              onPointerDown: (event) => {
                if (selection || event.button !== 0 || saving) return;
                const point = {
                  x: Math.min(Math.max(event.clientX, geom.left), geom.left + geom.width),
                  y: Math.min(Math.max(event.clientY, geom.top), geom.top + geom.height),
                };
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {}
                setDrag({ a: point, b: point });
              },
              onPointerMove: (event) => {
                if (!drag) return;
                const point = {
                  x: Math.min(Math.max(event.clientX, geom.left), geom.left + geom.width),
                  y: Math.min(Math.max(event.clientY, geom.top), geom.top + geom.height),
                };
                setDrag({ a: drag.a, b: point });
              },
              onPointerUp: (event) => {
                if (!drag) return;
                const point = {
                  x: Math.min(Math.max(event.clientX, geom.left), geom.left + geom.width),
                  y: Math.min(Math.max(event.clientY, geom.top), geom.top + geom.height),
                };
                const done = rectBetween(drag.a, point);
                setDrag(null);
                if (done.w >= MIN_SELECTION && done.h >= MIN_SELECTION) {
                  setShapes([]);
                  setSelection(done);
                  logEvent('select', { w: Math.round(done.w), h: Math.round(done.h) });
                }
              },
            },
            dimOutside ? null : h('div', { className: 'shotsnap-dim' }),
            nodes,
          )
        : null;

      // 一律 portal 到 body：宿主的标题栏/工具栏层级比 slot 容器高，
      // 不 portal 的话屏幕最上边一条会压不住，点下去就变成拖窗口。
      const portal = (node) => {
        if (!node || !createPortal) return node;
        try {
          return createPortal(node, document.body);
        } catch {
          return node;
        }
      };

      return h(React.Fragment, null, portal(layer), toastNode);
    }

    /* ============================== 插件装配 ============================== */

    return {
      inject: ['slots', 'shortcuts'],
      apply(ctx) {
        logEvent('apply.start');

        // 每一步单独兜底：某一步注册失败只记日志，不连累其它功能，也方便无 DevTools 排查
        const step = (name, run) => {
          try {
            run();
          } catch (error) {
            logEvent('apply.step.fail', { step: name, error: String((error && error.message) || error) });
          }
        };

        // 1) 样式：插件自带样式表，只用宿主主题变量，不改宿主类名
        step('styles', () => ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-dsh-shot-snap', '');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-shot-snap: styles'));

        // 2) 快捷键：注册进宿主快捷键中心 → 用户可在「设置 → 通用 → 快捷键」里改键位，冲突由宿主检测
        step('shortcuts', () =>
          ctx.effect(
            () =>
              ctx.shortcuts.register({
                id: COMMAND,
                label: () => '截图并插入输入框',
                aliases: ['screenshot', 'capture screen', 'shot', '截图', '截屏', '框选截图'],
                defaults: {
                  // 只声明桌面端默认键位：Web 端哪些组合键可用由宿主白名单决定，不强行占用
                  'desktop:macos': DEFAULT_BINDING,
                  'desktop:windows': DEFAULT_BINDING,
                  'desktop:linux': DEFAULT_BINDING,
                },
                regions: ['page', 'editable'],
                modals: [],
                resolve: () => {
                  if (state.phase === 'capturing') return { status: 'blocked', reason: '正在截图' };
                  if (state.phase === 'ready') {
                    return {
                      status: 'handled',
                      run: () => {
                        logEvent('cancel', { reason: 'shortcut' });
                        closeOverlay();
                      },
                    };
                  }
                  return {
                    status: 'handled',
                    run: () => {
                      void startCapture();
                    },
                  };
                },
              }),
            'dsh-shot-snap: capture command',
          ));

        // 2b) 键盘兜底：桌面端的原生键盘层只派发它自己同步过的命令，插件注册的绑定在那里实测不触发，
        // 所以这里按宿主快捷键目录里当前生效的键位再自己匹配一遍。命中后与按钮走同一条路径。
        step('hotkey', () => {
          hotkeyCatalog = ctx.shortcuts && ctx.shortcuts.catalog ? ctx.shortcuts.catalog : null;
          const onKeyDown = (event) => {
            if (event.defaultPrevented) return;
            if (event.isComposing || event.keyCode === 229) return;
            if (event.repeat) return;
            if (state.menu && state.menu.recording) return;
            if (insideOverlay(event)) return;
            const binding = currentBinding();
            if (!matchesBinding(event, binding)) return;
            // 宿主开着模态框（设置、命令面板等）时不抢键
            if (document.querySelector('[aria-modal="true"]') !== null) return;
            // 纯字符键（不带 Ctrl/Alt/Meta）在输入框里打字会误触发，只在非输入区响应
            const modifiers = Array.isArray(binding.modifiers) ? binding.modifiers : [];
            const strong = modifiers.some((modifier) => modifier === 'control' || modifier === 'alt' || modifier === 'meta');
            if (!strong && inEditable(event)) return;
            event.preventDefault();
            event.stopPropagation();
            triggerCapture('hotkey');
          };
          window.addEventListener('keydown', onKeyDown, true);
          return () => window.removeEventListener('keydown', onKeyDown, true);
        });

        // 3) 输入框工具行左侧的截图按钮 + 快捷键下拉箭头
        step('input.left', () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'shot-snap',
                order: 6,
                inject: () => ({ shortcuts: ctx.shortcuts }),
              },
              ShotButton,
            ),
          ),
        );

        // 4) 全屏框选遮罩 + 快捷键菜单（shell.overlay 自身 click-through，条目自己开 pointer-events）
        step('shell.overlay', () =>
          ctx.slots.inject('shell.overlay', () => {
            const disposeMenu = ctx.slots.register(
              { name: 'shell.overlay', id: 'shot-snap.menu', inject: () => ({ shortcuts: ctx.shortcuts }) },
              ShortcutMenu,
            );
            const disposeOverlay = ctx.slots.register(
              { name: 'shell.overlay', id: 'shot-snap.overlay' },
              ShotOverlay,
            );
            return () => {
              disposeOverlay();
              disposeMenu();
            };
          }),
        );

        logEvent('plugin.ready');
      },
    };
  },
});
