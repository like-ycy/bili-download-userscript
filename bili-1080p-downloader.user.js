// ==UserScript==
// @name         哔哩哔哩 1080P 下载
// @namespace    bili-1080p-downloader
// @version      0.1.0
// @description  使用网页登录态下载当前分 P 的普通 1080P，快速无损合并为带声音的 MP4。
// @license      MIT
// @match        https://www.bilibili.com/*
// @run-at       document-idle
// @noframes
// @require      https://cdn.jsdelivr.net/npm/blueimp-md5@2.19.0/js/md5.min.js
// @resource     BiliMux https://cdn.jsdelivr.net/npm/mediabunny@1.61.4/dist/bundles/mediabunny.min.cjs
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @connect      bilivideo.com
// @connect      bilivideo.cn
// ==/UserScript==

(() => {
  'use strict';

  const HOST_ID = 'bili-1080p-downloader';
  if (document.getElementById(HOST_ID)) return;
  const CDN_DOMAINS = ['bilivideo.com', 'bilivideo.cn'];
  const MAX_BYTES = 512 * 1024 * 1024;
  const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7,
    16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59,
    6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  let activeTask = null;
  let routeKey = '';

  function currentVideo() {
    const url = new URL(location.href);
    const match = url.pathname.match(/^\/video\/(BV[\da-zA-Z]+|av\d+)(?:\/|$)/);
    if (!match) return null;
    const page = Number(url.searchParams.get('p') || 1);
    if (!Number.isSafeInteger(page) || page < 1) return null;
    return { id: match[1], page, key: `${match[1]}:${page}` };
  }

  function abortError() {
    return new DOMException('已取消', 'AbortError');
  }

  function checkAbort(signal) {
    if (signal.aborted) throw signal.reason || abortError();
  }

  function bytes(value) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function filename(info) {
    const suffix = ` - ${info.bvid} - P${info.page} - 1080P.mp4`;
    const clean = String(info.title).normalize('NFC')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_')
      .replace(/\s+/g, ' ').trim();
    let title = '';
    const encoder = new TextEncoder();
    for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(clean)) {
      const next = title + segment;
      if ((next + suffix).length > 150 || encoder.encode(next + suffix).length > 220) break;
      title = next;
    }
    title = title.replace(/[. ]+$/g, '') || '哔哩哔哩视频';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = `_${title}`;
    return title + suffix;
  }

  async function api(path, params, signal) {
    checkAbort(signal);
    const query = typeof params === 'string' ? params : new URLSearchParams(params).toString();
    let response;
    try {
      response = await fetch(`https://api.bilibili.com${path}${query ? `?${query}` : ''}`, {
        credentials: 'include',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      });
    } catch (error) {
      checkAbort(signal);
      throw new Error(error.name === 'TimeoutError' ? 'B 站接口请求超时，请重试。' : '无法访问 B 站接口，请检查网络后重试。');
    }
    if (!response.ok) throw new Error(`B 站接口请求失败（HTTP ${response.status}）。`);
    const json = await response.json();
    if (json.code !== 0) {
      const error = new Error(`B 站接口：${String(json.message || '请求失败')}（${json.code}）`);
      error.apiCode = json.code;
      throw error;
    }
    return json.data;
  }

  function wbiQuery(params, nav) {
    const keys = ['img_url', 'sub_url'].map(key => {
      const value = nav.wbi_img?.[key];
      if (typeof value !== 'string') throw new Error('未取得播放接口签名，请刷新页面重试。');
      return new URL(value).pathname.split('/').pop().split('.')[0];
    }).join('');
    if (!/^[a-f\d]{64}$/i.test(keys)) throw new Error('播放接口签名已变化，请刷新页面重试。');
    const mixin = MIXIN.slice(0, 32).map(index => keys[index]).join('');
    const values = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(values).sort().map(key =>
      `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ''))}`).join('&');
    return `${query}&w_rid=${md5(query + mixin)}`;
  }

  async function resolveMedia(route, signal) {
    let nav = await api('/x/web-interface/nav', {}, signal);
    if (!nav.isLogin) throw new Error('请先在当前浏览器登录哔哩哔哩，然后重试。');
    const ids = route.id.startsWith('BV') ? { bvid: route.id } : { aid: route.id.slice(2) };
    const view = await api('/x/web-interface/view', ids, signal);
    const part = view?.pages?.find(entry => entry.page === route.page);
    if (!part || !Number.isSafeInteger(part.cid) || !/^BV[\da-zA-Z]+$/.test(view.bvid)) {
      throw new Error('无法识别当前分 P，请等视频加载后重试。');
    }
    const params = { bvid: view.bvid, cid: part.cid, qn: 80, fnver: 0, fnval: 4048, fourk: 0 };
    let play;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        play = await api('/x/player/wbi/playurl', wbiQuery(params, nav), signal);
        break;
      } catch (error) {
        if (attempt || error.apiCode !== -403) throw error;
        nav = await api('/x/web-interface/nav', {}, signal);
        if (!nav.isLogin) throw new Error('登录已失效，请重新登录后重试。');
      }
    }
    const videos = (play?.dash?.video || []).filter(v => Number(v.id) === 80);
    if (!videos.length) throw new Error('当前账号未取得普通 1080P 视频流。请确认网页可播放 1080P；本脚本不会自动降低画质。');
    const video = videos.filter(v => Number(v.codecid) === 7 && /^avc1\./i.test(v.codecs))
      .sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!video) throw new Error('这个视频没有可用的 1080P H.264 视频轨，首版暂不支持其编码。');
    const audio = (play.dash.audio || []).filter(a => /^mp4a\.40\./i.test(a.codecs))
      .sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!audio) throw new Error('没有取得可用的 AAC 音频轨，无法生成带声音的 MP4。');
    const title = view.pages.length > 1 ? `${view.title} - ${part.part}` : view.title;
    return { bvid: view.bvid, cid: part.cid, page: route.page, title, video, audio, duration: part.duration };
  }

  function mediaUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
      return CDN_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : '';
    } catch { return ''; }
  }

  function mediaUrls(stream) {
    return [...new Set([stream.baseUrl, stream.base_url, stream.backupUrl, stream.backup_url]
      .flat().map(mediaUrl).filter(Boolean))];
  }

  function requestBlob(url, signal, onProgress) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      let request;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => {
        finish(signal.reason || abortError());
        request?.abort();
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        request = GM_xmlhttpRequest({
          method: 'GET', url, responseType: 'blob', anonymous: true, timeout: 180000,
          headers: { Referer: 'https://www.bilibili.com/' },
          onprogress(event) {
            if (!settled) onProgress(event.loaded || 0, event.lengthComputable ? event.total : 0);
          },
          onload(response) {
            if (settled) return;
            if (response.status !== 200 || !mediaUrl(response.finalUrl || url)) {
              finish(new Error(`媒体服务器返回异常（HTTP ${response.status}）。`));
              return;
            }
            const blob = response.response;
            const length = Number((response.responseHeaders || '').match(/^content-length:\s*(\d+)/im)?.[1] || 0);
            if (!(blob instanceof Blob) || !blob.size || (length && length !== blob.size)) {
              finish(new Error('下载文件不完整，请重试。'));
              return;
            }
            onProgress(blob.size, blob.size);
            if (!signal.aborted) finish(null, blob);
          },
          onerror: () => finish(new Error('媒体下载失败，请检查网络或油猴的域名访问权限。')),
          ontimeout: () => finish(new Error('媒体下载超时，请重试。')),
          onabort: () => finish(signal.reason || abortError()),
        });
      } catch (error) { finish(error); }
    });
  }

  async function downloadTrack(stream, signal, onProgress) {
    const urls = mediaUrls(stream);
    if (!urls.length) throw new Error('没有可用的 B 站媒体地址。');
    let failure;
    for (const url of urls) {
      checkAbort(signal);
      onProgress(0, 0);
      try { return await requestBlob(url, signal, onProgress); }
      catch (error) { checkAbort(signal); failure = error; }
    }
    throw failure;
  }

  // 在 Worker 中直接搬运编码包；不调用解码器、编码器或 FFmpeg。
  function muxWorkerMain() {
    self.onmessage = async ({ data }) => {
      const started = performance.now();
      const { Input, MP4, BlobSource, Output, Mp4OutputFormat, BufferTarget,
        EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource } = Mediabunny;
      const inputs = [];
      let output;
      try {
        const videoInput = new Input({ formats: [MP4], source: new BlobSource(data.video) });
        const audioInput = new Input({ formats: [MP4], source: new BlobSource(data.audio) });
        inputs.push(videoInput, audioInput);
        const [video, audio] = await Promise.all([videoInput.getPrimaryVideoTrack(), audioInput.getPrimaryAudioTrack()]);
        if (!video || !audio) throw new Error('下载文件缺少视频轨或音频轨。');
        const [videoCodec, audioCodec, videoConfig, audioConfig, rotation, videoDuration, audioDuration] = await Promise.all([
          video.getCodec(), audio.getCodec(), video.getDecoderConfig(), audio.getDecoderConfig(), video.getRotation(),
          video.computeDuration(), audio.computeDuration(),
        ]);
        if (videoCodec !== 'avc' || audioCodec !== 'aac' || !videoConfig || !audioConfig) {
          throw new Error('下载文件的编码不符合 H.264 + AAC。');
        }
        if (videoConfig.codedWidth !== data.width || videoConfig.codedHeight !== data.height) {
          throw new Error('下载文件的分辨率与播放接口不一致。');
        }
        // 接口时长以整秒表示，留出取整与正常尾帧差异；拒绝截断的播放片段。
        if (![videoDuration, audioDuration].every(value => Number.isFinite(value) && value > 0)
          || (data.duration > 0 && Math.min(videoDuration, audioDuration) + 2 < data.duration)) {
          throw new Error('下载的音视频时长不完整，请重新解析后再试。');
        }
        const target = new BufferTarget();
        output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
        const videoSource = new EncodedVideoPacketSource('avc');
        const audioSource = new EncodedAudioPacketSource('aac');
        output.addVideoTrack(videoSource, { rotation });
        output.addAudioTrack(audioSource);
        await output.start();
        const total = data.video.size + data.audio.size;
        let copied = 0;
        let lastUpdate = 0;
        const copy = async (track, source, decoderConfig) => {
          let count = 0;
          // packets() 已按解码顺序返回；保留原始时间戳，不能按显示时间排序 B 帧。
          for await (const packet of new EncodedPacketSink(track).packets()) {
            await source.add(packet, count === 0 ? { decoderConfig } : undefined);
            count++;
            copied += packet.data.byteLength;
            if (performance.now() - lastUpdate > 150) {
              self.postMessage({ type: 'progress', ratio: Math.min(copied / total, 0.99) });
              lastUpdate = performance.now();
            }
          }
          if (!count) throw new Error('下载文件中没有可合并的媒体数据。');
          source.close();
          return count;
        };
        const counts = await Promise.all([copy(video, videoSource, videoConfig), copy(audio, audioSource, audioConfig)]);
        await output.finalize();
        self.postMessage({ type: 'done', buffer: target.buffer, counts, seconds: (performance.now() - started) / 1000 }, [target.buffer]);
      } catch (error) {
        if (output) await output.cancel().catch(() => {});
        self.postMessage({ type: 'error', message: error.message || '音视频合并失败。' });
      } finally { inputs.forEach(input => input.dispose()); }
    };
  }

  function mux(info, video, audio, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const library = GM_getResourceText('BiliMux');
      if (!library) throw new Error('合并组件未加载，请在油猴中重新安装脚本后重试。');
      const url = URL.createObjectURL(new Blob([library, '\n;(', muxWorkerMain.toString(), ')();'], { type: 'text/javascript' }));
      let worker;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        worker?.terminate();
        URL.revokeObjectURL(url);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(signal.reason || abortError());
      const timeout = setTimeout(() => finish(new Error('合并超时，请尝试较短的视频。')), 120000);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        worker = new Worker(url);
        worker.onerror = () => finish(new Error('无法启动音视频合并组件，请检查油猴资源加载情况后重试。'));
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') status('正在合并音视频…', data.ratio);
          if (data.type === 'error') finish(new Error(data.message));
          if (data.type === 'done') finish(null, data);
        };
        worker.postMessage({ video, audio, width: info.video.width, height: info.video.height, duration: info.duration });
      } catch (error) { finish(error); }
    });
  }

  function save(buffer, name) {
    const blob = new Blob([buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function startDownload() {
    if (activeTask) { ui.panel.hidden = false; return; }
    const route = currentVideo();
    if (!route) return;
    const controller = new AbortController();
    activeTask = controller;
    ui.panel.hidden = false;
    ui.download.disabled = true;
    ui.launch.textContent = '查看下载进度';
    ui.cancel.hidden = false;
    ui.title.textContent = '正在读取当前视频…';
    ui.details.textContent = '普通 1080P · 含声音';
    status('正在获取播放地址…');
    const started = performance.now();
    try {
      const info = await resolveMedia(route, controller.signal);
      checkAbort(controller.signal);
      ui.title.textContent = info.title;
      ui.details.textContent = `P${info.page} · ${info.video.width} × ${info.video.height} · 1080P`;
      const loaded = [0, 0];
      const totals = [0, 0];
      const progress = index => (size, total) => {
        if (controller.signal.aborted) return;
        loaded[index] = size;
        totals[index] = total;
        const sum = loaded[0] + loaded[1];
        if (Math.max(loaded[0], totals[0]) + Math.max(loaded[1], totals[1]) > MAX_BYTES) {
          controller.abort(new Error('音视频合计超过首版的 512 MB 上限，请使用桌面下载器下载这个视频。'));
          return;
        }
        const known = totals.every(value => value > 0);
        const all = totals[0] + totals[1];
        status(`正在下载 · ${bytes(sum)}${known ? ` / ${bytes(all)}` : ''}`, known ? sum / all : null);
      };
      const [video, audio] = await Promise.all([
        downloadTrack(info.video, controller.signal, progress(0)),
        downloadTrack(info.audio, controller.signal, progress(1)),
      ]);
      checkAbort(controller.signal);
      status('正在合并音视频…', 0);
      const result = await mux(info, video, audio, controller.signal);
      checkAbort(controller.signal);
      const name = filename(info);
      save(result.buffer, name);
      status(`已交给浏览器保存 · 合并 ${result.seconds.toFixed(2)} 秒 · 共 ${((performance.now() - started) / 1000).toFixed(1)} 秒`, 1);
      ui.details.textContent = name;
      console.info('[Bili1080P] 已生成 MP4', { bvid: info.bvid, cid: info.cid,
        size: result.buffer.byteLength, muxSeconds: result.seconds, videoPackets: result.counts[0], audioPackets: result.counts[1] });
    } catch (error) {
      // 任一下载失败时同时中止另一条轨道，避免后台残留请求。
      controller.abort(error);
      status(error.name === 'AbortError' ? '已取消下载。' : error.message || '下载失败，请重试。');
    } finally {
      activeTask = null;
      ui.download.disabled = false;
      ui.launch.textContent = '↓ 下载 1080P';
      ui.cancel.hidden = true;
      ui.progress.hidden = !ui.progress.hasAttribute('value');
      syncRoute();
    }
  }

  function status(message, ratio = null) {
    ui.status.textContent = message;
    if (ratio === null) ui.progress.removeAttribute('value');
    else ui.progress.value = Math.max(0, Math.min(ratio, 1));
    ui.progress.hidden = !activeTask && ratio !== 1;
  }

  function mount() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    // 限定样式作用域，避免站点样式影响进度条和按钮。
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial;position:fixed;right:24px;bottom:84px;z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172b3a;font-size:14px}
        *{box-sizing:border-box} [hidden]{display:none!important}
        button{font:inherit;cursor:pointer;border:0;border-radius:10px;padding:10px 15px;background:#eef3f7;color:#26465d}
        button:focus-visible{outline:3px solid #73cfff;outline-offset:3px} button:disabled{cursor:wait;opacity:.65}
        .primary{background:#008ac5;color:white;font-weight:600}
        #launch{box-shadow:0 4px 18px #001b3b33;border:1px solid #ffffff88;border-radius:24px;padding:12px 20px;float:right}
        section{width:350px;max-width:calc(100vw - 32px);margin-bottom:12px;background:#fff;border:1px solid #deebf3;border-radius:16px;box-shadow:0 12px 48px #001b3b26;padding:20px}
        header{display:flex;align-items:center;justify-content:space-between;margin-bottom:15px}strong{font-size:16px}#close{padding:2px 8px;background:transparent;font-size:22px;color:#758796}
        #title{font-weight:600;line-height:1.6;overflow-wrap:anywhere;max-height:100px;overflow:auto}
        #details{color:#688093;font-size:12px;line-height:1.6;margin-top:7px;overflow-wrap:anywhere}
        #status{line-height:1.7;margin:16px 0 8px;overflow-wrap:anywhere;min-height:24px}
        progress{width:100%;height:7px;accent-color:#008ac5;display:block;margin:12px 0 18px}
        footer{display:flex;gap:9px;margin-top:14px} footer .primary{flex:1}
        @media(max-width:500px){:host{right:16px;bottom:24px}}
      </style>
      <section id="panel" hidden aria-label="哔哩哔哩视频下载">
        <header><strong>下载当前视频</strong><button id="close" aria-label="收起下载面板">×</button></header>
        <div id="title">当前分 P</div><div id="details">普通 1080P · 含声音</div>
        <div id="status" role="status" aria-live="polite">使用当前网页登录状态下载。</div>
        <progress id="progress" max="1" hidden></progress>
        <footer><button id="download" class="primary">下载 1080P</button><button id="cancel" hidden>取消</button></footer>
      </section>
      <button id="launch" class="primary" title="下载当前分 P 的 1080P 视频">↓ 下载 1080P</button>`;
    document.documentElement.append(host);
    const elements = { host };
    for (const id of ['panel', 'title', 'details', 'status', 'progress', 'download', 'cancel', 'launch', 'close']) {
      elements[id] = shadow.getElementById(id);
    }
    elements.launch.addEventListener('click', startDownload);
    elements.download.addEventListener('click', startDownload);
    elements.cancel.addEventListener('click', () => activeTask?.abort(abortError()));
    elements.close.addEventListener('click', () => { elements.panel.hidden = true; });
    return elements;
  }

  function syncRoute() {
    const route = currentVideo();
    ui.host.style.display = route || activeTask ? 'block' : 'none';
    if (activeTask || route?.key === routeKey) return;
    routeKey = route?.key || '';
    ui.panel.hidden = true;
    ui.title.textContent = route ? `当前分 P：P${route.page}` : '当前分 P';
    ui.details.textContent = '普通 1080P · 含声音';
    status('使用当前网页登录状态下载。');
  }

  const ui = mount();
  syncRoute();
  setInterval(syncRoute, 1000);
})();
