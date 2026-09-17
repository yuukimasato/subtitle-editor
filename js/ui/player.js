// ArtPlayer 装配、播放控制条、试听窗口与文本字幕 overlay。
// 快捷键全部由 shortcuts.js 接管（ArtPlayer 内置热键已关闭）。
import Artplayer from '../../vendor/artplayer.mjs';
import { formatClock } from '../format/time.js';
import { splitSpeaker } from '../format/cue.js';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const FPSES = [23.976, 24, 25, 29.97, 30];

export function createPlayer({ store, mountEl, transportEl, onError }) {
  let art = null;
  let mediaUrl = null;
  let auditionEnd = null;
  let lastPlayStart = 0;
  const timeListeners = new Set();
  let lastPreviewText = null;
  let transportSync = null; // buildTransport 装配的图标同步函数，art.video 就绪后再挂 play/pause 监听
  let timeLabelEl = null; // buildTransport 装配，tick 每帧刷新
  let lastTimeLabelText = '';

  const previewEl = document.createElement('div');
  previewEl.className = 'subtitle-preview';
  previewEl.hidden = true;

  // ---------- 控制条 ----------
  function buildTransport() {
    const mk = (tag, className, parent) => {
      const node = document.createElement(tag);
      node.className = className;
      parent.appendChild(node);
      return node;
    };
    const btn = (label, title, onClick) => {
      const b = mk('button', 'tbtn', transportEl);
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      return b;
    };
    const playBtn = btn('▶', '播放 / 暂停（Space）', () => playPause());
    const btnStop = btn('⏹', '停止并回到播放起点（小键盘 8）', () => stop());
    btn('«', '上一帧（,）', () => frameStep(-1));
    btn('»', '下一帧（.）', () => frameStep(+1));
    const timeLabel = mk('span', 'time-label mono', transportEl);
    timeLabel.textContent = '0:00.000 / 0:00.000';
    timeLabelEl = timeLabel;

    const rateSel = mk('select', 'tsel', transportEl);
    rateSel.title = '播放倍速';
    RATES.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = String(r);
      opt.textContent = `${r}×`;
      rateSel.appendChild(opt);
    });
    rateSel.value = '1';
    rateSel.addEventListener('change', () => setRate(Number(rateSel.value)));

    const fpsSel = mk('select', 'tsel', transportEl);
    fpsSel.title = '逐帧步长（帧率）';
    FPSES.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = String(f);
      opt.textContent = `${f} fps`;
      fpsSel.appendChild(opt);
    });
    fpsSel.value = '25';
    fpsSel.addEventListener('change', () => store.patch({ fps: Number(fpsSel.value) }));

    const volume = mk('input', 'tvol', transportEl);
    volume.type = 'range';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.05';
    volume.value = '1';
    volume.title = '音量';
    volume.setAttribute('aria-label', '音量');
    volume.addEventListener('input', () => {
      if (art) art.video.volume = Number(volume.value);
    });

    const loopBtn = btn('⟳ 循环当前句', '循环当前句（L）', () => store.patch({ loopCue: !store.state.loopCue }));
    const previewBtn = btn('预览', '在画面上显示当前字幕文本（本开关无快捷键）', () => store.patch({ previewOn: !store.state.previewOn }));
    const assBtn = btn('ASS 样式预览', '使用 libass 按样式渲染 ASS 字幕', () => store.patch({ assPreview: !store.state.assPreview }));

    const sync = () => {
      playBtn.textContent = art && !art.video.paused ? '⏸' : '▶';
      loopBtn.classList.toggle('active', store.state.loopCue);
      previewBtn.classList.toggle('active', store.state.previewOn);
      assBtn.classList.toggle('active', store.state.assPreview);
      // 纯音频媒体没有视频画面，libass 无法出图，预览不可用（自动走文本 overlay）
      const hasPicture = Boolean(art && art.video.videoWidth > 0 && art.video.videoHeight > 0);
      assBtn.disabled = store.state.subtitleFormat !== 'ass' || !hasPicture;
      assBtn.title = hasPicture
        ? '使用 libass 按样式渲染 ASS 字幕'
        : '使用 libass 按样式渲染 ASS 字幕（当前媒体无视频画面，不可用）';
      assBtn.setAttribute('aria-label', assBtn.title);
    };
    store.on('loopCue', sync);
    store.on('previewOn', sync);
    store.on('assPreview', sync);
    store.on('subtitleFormat', sync);
    store.on('mediaLoaded', sync);
    transportSync = sync;
    sync();
  }

  // 播放/暂停图标跟随视频状态：art 在 createPlayer 时尚不存在，
  // 等 loadFile 创建/换源后就绪再挂监听（video 元素复用，去重防重复挂载）
  function attachTransportSync(videoEl) {
    if (!transportSync || !videoEl || videoEl.dataset.transportSyncBound) return;
    videoEl.dataset.transportSyncBound = '1';
    videoEl.addEventListener('play', transportSync);
    videoEl.addEventListener('pause', transportSync);
  }

  // ---------- 播放器 ----------
  function buildPlayer(url) {
    const instance = new Artplayer({
      container: mountEl,
      url,
      autoplay: false,
      setting: false,
      hotkey: false,
      loop: false,
      flip: false,
      playbackRate: false,
      aspectRatio: false,
      screenshot: false,
      pip: false,
      mutex: false,
      autoSize: false,
      autoMini: false,
      fullscreen: true,
      contextmenu: [],
      controls: [],
      icons: {},
      layers: [
        {
          name: 'cuePreview',
          html: previewEl,
          style: {},
        },
      ],
      moreVideoAttr: { playsInline: true, preload: 'auto' },
    });
    instance.on('error', (event) => onError?.(event));
    return instance;
  }

  async function loadFile(file) {
    // 旧 blob URL 延迟回收：在途的旧媒体加载（video/波形）仍可能引用它，
    // 提前 revoke 会把旧加载炸掉；等新 URL 已赋值且元数据就绪后再异步回收。
    // 加载中途失败（含解码失败）直接抛出，不回收任何 URL，旧画面/波形得以保留。
    const previousUrl = mediaUrl;
    mediaUrl = URL.createObjectURL(file);
    if (!art) {
      art = buildPlayer(mediaUrl);
      art.video.addEventListener('play', () => {
        lastPlayStart = art.video.currentTime;
      });
    } else {
      await art.switchUrl(mediaUrl);
    }
    attachTransportSync(art.video);
    const v = art.video;
    if (v.readyState < 1) {
      await new Promise((resolve, reject) => {
        const ok = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(new Error('浏览器无法解码该媒体文件'));
        };
        const cleanup = () => {
          v.removeEventListener('loadedmetadata', ok);
          v.removeEventListener('error', bad);
        };
        v.addEventListener('loadedmetadata', ok);
        v.addEventListener('error', bad);
      });
    }
    store.patch({
      mediaName: file.name,
      mediaLoaded: true,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
    });
    // 成功后再回收旧 URL（ArtPlayer 的 url setter 内部也会 revoke 一次，重复调用无害）
    if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 0);
    return mediaUrl;
  }

  function video() {
    return art?.video ?? null;
  }

  function isPlaying() {
    const v = video();
    return Boolean(v && !v.paused);
  }

  function currentTime() {
    return art?.video?.currentTime ?? 0;
  }

  // ---------- 播放控制 ----------
  function playPause() {
    const v = video();
    if (!v) return;
    if (v.paused) v.play()?.catch(() => {});
    else v.pause();
  }

  function stop() {
    const v = video();
    if (!v) return;
    v.pause();
    auditionEnd = null;
    v.currentTime = lastPlayStart;
  }

  function stopAudition() {
    const v = video();
    auditionEnd = null;
    v?.pause();
  }

  function seek(t) {
    const v = video();
    if (!v) return;
    const max = store.state.duration || Number.POSITIVE_INFINITY;
    v.currentTime = Math.min(Math.max(0, t), max);
  }

  function frameStep(direction) {
    const v = video();
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, v.currentTime + direction / (store.state.fps || 25));
  }

  function playRange(a, b) {
    const v = video();
    if (!v) return;
    lastPlayStart = Math.max(0, a);
    v.currentTime = Math.max(0, a);
    auditionEnd = b;
    v.play()?.catch(() => {});
  }

  function currentTimingCue() {
    const t = video()?.currentTime ?? 0;
    return store.selectedCue() ?? store.cueAt(t);
  }

  function playCurrentCue() {
    const cue = currentTimingCue();
    if (!cue) return;
    playRange(cue.start, cue.end);
  }

  function auditionBefore() {
    const cue = currentTimingCue();
    if (!cue) return;
    playRange(Math.max(0, cue.start - 0.5), cue.start);
  }

  function auditionAfter() {
    const cue = currentTimingCue();
    if (!cue) return;
    playRange(cue.end, Math.min(store.state.duration || cue.end + 0.5, cue.end + 0.5));
  }

  function setRate(rate) {
    const v = video();
    if (v) v.playbackRate = rate;
    store.patch({ rate });
  }

  function onTime(fn) {
    timeListeners.add(fn);
    return () => timeListeners.delete(fn);
  }

  // 控制条时间标签：每帧调用，仅在文本变化时写 DOM
  function syncTimeLabel(t) {
    if (!timeLabelEl) return;
    const text = `${formatClock(t)} / ${formatClock(store.state.duration || 0)}`;
    if (text !== lastTimeLabelText) {
      lastTimeLabelText = text;
      timeLabelEl.textContent = text;
    }
  }

  // 文本预览用：ASS 的 {\...} 覆盖标签只对 libass 有意义，纯文本预览中剥离；
  // 说话人前缀是编辑台的标注约定，同样不属于画面上的字幕内容
  function previewText(cue) {
    const raw = String(cue.text ?? '');
    const noTags = store.state.subtitleFormat === 'ass' ? raw.replace(/\{[^}]*\}/g, '') : raw;
    return splitSpeaker(noTags).body;
  }

  // ---------- rAF 循环：时间分发 / 试听窗口 / 循环当前句 / 文本预览 ----------
  function tick() {
    const v = video();
    if (v) {
      const t = v.currentTime;
      timeListeners.forEach((fn) => fn(t, !v.paused));
      syncTimeLabel(t);
      if (!v.paused) {
        if (auditionEnd !== null && t >= auditionEnd - 1e-3) {
          v.pause();
          auditionEnd = null;
        } else if (store.state.loopCue) {
          const cue = store.cueAt(t);
          if (cue && t >= cue.end - 1e-3) v.currentTime = cue.start;
        }
      }
      const cue = store.cueAt(t);
      const text = store.state.previewOn && !assPreviewActive && cue ? previewText(cue) : '';
      if (text !== lastPreviewText) {
        previewEl.textContent = text;
        previewEl.hidden = !text;
        lastPreviewText = text;
      }
    }
    requestAnimationFrame(tick);
  }

  // ass-preview 激活时隐藏文本 overlay，由 libass 接管渲染
  let assPreviewActive = false;
  function setAssPreviewActive(active) {
    assPreviewActive = active;
    if (active) {
      previewEl.hidden = true;
      previewEl.textContent = '';
      lastPreviewText = '';
    }
  }

  buildTransport();
  requestAnimationFrame(tick);

  return {
    loadFile,
    video,
    currentTime,
    isPlaying,
    playPause,
    stop,
    stopAudition,
    seek,
    frameStep,
    playRange,
    playCurrentCue,
    auditionBefore,
    auditionAfter,
    setRate,
    onTime,
    setAssPreviewActive,
  };
}
