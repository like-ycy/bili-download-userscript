// ==UserScript==
// @name         哔哩哔哩 1080P 下载
// @namespace    bili-1080p-downloader
// @version      0.3.2
// @description  拖动下载图标，选择视频画质下载带声音的 MP4，或下载动态中的原图与图集 ZIP。
// @author       like-ycy
// @license      MIT
// @homepageURL  https://github.com/like-ycy/bili-download-userscript
// @supportURL   https://github.com/like-ycy/bili-download-userscript/issues
// @icon         https://www.bilibili.com/favicon.ico
// @match        https://www.bilibili.com/*
// @match        https://t.bilibili.com/*
// @run-at       document-idle
// @noframes
// @require      https://cdn.jsdelivr.net/npm/blueimp-md5@2.19.0/js/md5.min.js
// @resource     BiliMux https://cdn.jsdelivr.net/npm/mediabunny@1.61.4/dist/bundles/mediabunny.min.cjs
// @resource     BiliZip https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      bilivideo.com
// @connect      bilivideo.cn
// @connect      hdslb.com
// ==/UserScript==

(() => {
  'use strict';

  const HOST_ID = 'bili-1080p-downloader';
  if (document.getElementById(HOST_ID)) return;
  const CDN_DOMAINS = { video: ['bilivideo.com', 'bilivideo.cn'], image: ['hdslb.com'] };
  const MAX_BYTES = 512 * 1024 * 1024;
  const QUALITY_NAMES = { 6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60', 80: '1080P' };
  const CODECS = [{ id: 7, prefix: 'avc1.', name: 'H.264', mux: 'avc' },
    { id: 12, prefix: 'hvc1.', name: 'H.265', mux: 'hevc' },
    { id: 13, prefix: 'av01.', name: 'AV1', mux: 'av1' }];
  const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7,
    16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59,
    6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  let activeTask = null;
  let inspection = null;
  let routeKey = '';

  function currentRoute() {
    const url = new URL(location.href);
    const album = url.hostname === 't.bilibili.com' ? url.pathname.match(/^\/(\d+)\/?$/)
      : url.hostname === 'www.bilibili.com' ? url.pathname.match(/^\/opus\/(\d+)\/?$/) : null;
    if (album) return { kind: 'album', id: album[1], key: `album:${album[1]}` };
    if (url.hostname !== 'www.bilibili.com') return null;
    const match = url.pathname.match(/^\/video\/(BV[\da-zA-Z]+|av\d+)(?:\/|$)/);
    if (!match) return null;
    const page = Number(url.searchParams.get('p') || 1);
    if (!Number.isSafeInteger(page) || page < 1) return null;
    return { kind: 'video', id: match[1], page, key: `video:${match[1]}:${page}` };
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

  function qualityName(qn) { return QUALITY_NAMES[qn] || `画质${Number(qn)}`; }

  function filename(info) {
    const suffix = ` - P${info.page} - ${qualityName(info.qn)}.mp4`;
    return safeFilename(info.title, suffix, '哔哩哔哩视频');
  }

  function safeFilename(value, suffix, fallback) {
    const clean = String(value).normalize('NFC')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_')
      .replace(/\s+/g, ' ').trim();
    let title = '';
    const encoder = new TextEncoder();
    for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(clean)) {
      const next = title + segment;
      if ((next + suffix).length > 150 || encoder.encode(next + suffix).length > 220) break;
      title = next;
    }
    title = title.replace(/[. ]+$/g, '') || fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = `_${title}`;
    return title + suffix;
  }

  function albumFilename(info, row) {
    const suffix = row ? ` - ${info.id} - ${String(row.index).padStart(2, '0')}.${row.extension}` : ` - ${info.id}.zip`;
    return safeFilename(info.title, suffix, '哔哩哔哩图集');
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

  async function loginInfo(signal) {
    const nav = await api('/x/web-interface/nav', {}, signal);
    if (!nav.isLogin) throw new Error('请先在当前浏览器登录哔哩哔哩，然后重试。');
    return nav;
  }

  async function videoInfo(route, signal) {
    const ids = route.id.startsWith('BV') ? { bvid: route.id } : { aid: route.id.slice(2) };
    const view = await api('/x/web-interface/view', ids, signal);
    const part = view?.pages?.find(entry => entry.page === route.page);
    if (!part || !Number.isSafeInteger(part.cid) || !/^BV[\da-zA-Z]+$/.test(view.bvid)) {
      throw new Error('无法识别当前分 P，请等视频加载后重试。');
    }
    const title = view.pages.length > 1 ? `${view.title} - ${part.part}` : view.title;
    const author = view.owner?.name || '哔哩哔哩视频';
    return { bvid: view.bvid, cid: part.cid, page: route.page, title: `${author} - ${title}`, duration: part.duration };
  }

  async function albumInfo(route, signal) {
    const data = await api('/x/polymer/web-dynamic/v1/detail', { id: route.id, features: 'itemOpusStyle' }, signal);
    const item = data?.item;
    if (item?.id_str !== route.id) throw new Error('动态信息与当前页面不一致，请刷新列表重试。');
    if (item.type !== 'DYNAMIC_TYPE_DRAW') throw new Error('当前动态不是图集，暂不支持下载。');
    const dynamic = item.modules?.module_dynamic;
    const major = dynamic?.major;
    const pictures = major?.type === 'MAJOR_TYPE_OPUS' ? major.opus?.pics
      : major?.type === 'MAJOR_TYPE_DRAW' ? major.draw?.items : null;
    if (!Array.isArray(pictures) || !pictures.length) throw new Error('没有取得图集原图，请刷新列表重试。');
    const rows = pictures.map((picture, index) => {
      const url = originalImageUrl(major.type === 'MAJOR_TYPE_OPUS' ? picture.url : picture.src);
      if (!url) throw new Error(`第 ${index + 1} 张图片的原图地址无效，已停止读取图集。`);
      const size = Number(picture.size) * 1024;
      return { index: index + 1, url, extension: new URL(url).pathname.split('.').pop().toLowerCase(),
        width: Number(picture.width), height: Number(picture.height),
        size: Number.isFinite(size) && size > 0 ? Math.round(size) : null };
    });
    const author = item.modules?.module_author?.name || '哔哩哔哩图集';
    const description = major.opus?.title || major.opus?.summary?.text || dynamic.desc?.text || '';
    return { info: { id: route.id, title: description ? `${author} - ${description}` : author }, rows };
  }

  async function playInfo(info, qn, signal, nav) {
    nav ||= await loginInfo(signal);
    const params = { bvid: info.bvid, cid: info.cid, qn, fnver: 0, fnval: 4048, fourk: 0 };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await api('/x/player/wbi/playurl', wbiQuery(params, nav), signal);
      } catch (error) {
        if (attempt || error.apiCode !== -403) throw error;
        nav = await loginInfo(signal);
      }
    }
  }

  function ordinaryQuality(qn, play) {
    const format = play?.support_formats?.find(entry => Number(entry.quality) === qn);
    return Number.isInteger(qn) && qn > 0 && qn <= 80 && !format?.need_vip;
  }

  function audioStream(play) {
    const audio = (play?.dash?.audio || []).filter(a => /^mp4a\.40\./i.test(a.codecs) && mediaUrls(a).length)
      .sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!audio) throw new Error('没有取得可用的 AAC 音频轨，无法生成带声音的 MP4。');
    return audio;
  }

  function qualityRows(play) {
    const rows = new Map();
    for (const codec of CODECS) {
      const streams = (play?.dash?.video || []).filter(v => Number(v.codecid) === codec.id
        && String(v.codecs).startsWith(codec.prefix) && ordinaryQuality(Number(v.id), play) && mediaUrls(v).length)
        .sort((a, b) => b.bandwidth - a.bandwidth);
      for (const video of streams) {
        const qn = Number(video.id);
        if (!rows.has(qn)) rows.set(qn, { qn, video, codec, size: null, probing: true });
      }
    }
    return [...rows.values()].sort((a, b) => b.qn - a.qn);
  }

  async function resolveQualities(route, signal, onInfo) {
    const nav = await loginInfo(signal);
    const info = await videoInfo(route, signal);
    onInfo(info);
    const play = await playInfo(info, 80, signal, nav);
    const audio = audioStream(play);
    const rows = new Map(qualityRows(play).map(row => [row.qn, { ...row, audio }]));
    // 部分稿件一次响应不含全部已声明档位；补取后仍只接受实际返回的流。
    const declared = [...new Set((play.support_formats || []).map(entry => Number(entry.quality)))];
    let incomplete = false;
    for (const qn of declared.filter(qn => qn !== 80 && ordinaryQuality(qn, play) && !rows.has(qn))) {
      try {
        const extra = await playInfo(info, qn, signal, nav);
        const extraAudio = audioStream(extra);
        for (const row of qualityRows(extra)) if (!rows.has(row.qn)) rows.set(row.qn, { ...row, audio: extraAudio });
      } catch { checkAbort(signal); incomplete = true; }
    }
    if (!rows.size) throw new Error('当前视频没有取得普通账号可下载的画质，请确认登录状态后刷新列表。');
    return { info, rows: [...rows.values()].sort((a, b) => b.qn - a.qn), incomplete };
  }

  function mediaUrl(value, kind = 'video') {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
      return CDN_DOMAINS[kind]?.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : '';
    } catch { return ''; }
  }

  function originalImageUrl(value) {
    const allowed = mediaUrl(value, 'image');
    if (!allowed) return '';
    const url = new URL(allowed);
    url.pathname = url.pathname.split('@')[0];
    if (!/^\/bfs\/(new_dyn|album)\/[\da-z_-]+\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(url.pathname)) return '';
    url.search = ''; url.hash = '';
    return url.href;
  }

  function mediaUrls(stream) {
    return [...new Set([stream.baseUrl, stream.base_url, stream.backupUrl, stream.backup_url]
      .flat().map(value => mediaUrl(value)).filter(Boolean))];
  }

  function header(response, name) {
    return String(response.responseHeaders || '').split(/\r?\n/)
      .find(line => line.slice(0, line.indexOf(':')).toLowerCase() === name.toLowerCase())
      ?.slice(name.length + 1).trim() || '';
  }

  function responseSize(response) {
    const range = header(response, 'content-range').match(/^bytes\s+0-0\/(\d+)$/i);
    const size = Number(response.status === 206 ? range?.[1] : header(response, 'content-length'));
    return Number.isSafeInteger(size) && size > 0 ? size : null;
  }

  function requestMedia(url, { signal, method = 'GET', range = false, onProgress, kind = 'video' } = {}) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const validate = kind === 'image' ? originalImageUrl : value => mediaUrl(value, kind);
      url = validate(url);
      if (!url) throw new Error('媒体地址不属于允许的 B 站域名或路径。');
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
      const receive = response => {
        if (![200, ...(range ? [206] : [])].includes(response.status) || !validate(response.finalUrl || url)) {
          finish(new Error(`媒体服务器返回异常（HTTP ${response.status}）。`));
        } else if (kind === 'image' && !/^image\/(jpeg|png|gif|webp|avif|bmp|x-ms-bmp)(?:;|$)/i.test(header(response, 'content-type'))) {
          finish(new Error('图片服务器没有返回可用的原图。'));
        } else if (/text\/|json/i.test(header(response, 'content-type'))) {
          finish(new Error('媒体服务器返回了错误页面。'));
        } else finish(null, response);
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        request = GM_xmlhttpRequest({
          method, url, responseType: 'blob', anonymous: true, timeout: range || method === 'HEAD' ? 10000 : 180000,
          headers: { Referer: 'https://www.bilibili.com/', ...(range ? { Range: 'bytes=0-0' } : {}) },
          onreadystatechange(response) {
            // Range 探测取得响应头即停止正文，CDN 忽略 Range 也不读取整个视频。
            if (range && !settled && response.readyState === 2 && response.status) {
              receive(response);
              request?.abort();
            }
          },
          onprogress(event) {
            if (settled) return;
            if (range && event.loaded > 65536) {
              finish(new Error('媒体服务器未按范围响应，已停止读取。'));
              request?.abort();
            } else onProgress?.(event.loaded || 0, event.lengthComputable ? event.total : 0);
          },
          onload(response) {
            if (settled) return;
            receive(response);
          },
          onerror: () => finish(new Error('媒体下载失败，请检查网络或油猴的域名访问权限。')),
          ontimeout: () => finish(new Error('媒体下载超时，请重试。')),
          onabort: () => finish(signal.reason || abortError()),
        });
      } catch (error) { finish(error); }
    });
  }

  async function requestBlob(url, signal, onProgress, kind = 'video') {
    const response = await requestMedia(url, { signal, onProgress, kind });
    checkAbort(signal);
    const blob = response.response;
    const length = responseSize(response);
    if (!(blob instanceof Blob) || !blob.size || (length && length !== blob.size)) throw new Error('下载文件不完整，请重试。');
    onProgress(blob.size, blob.size);
    checkAbort(signal);
    return blob;
  }

  async function probeTrack(stream, signal) {
    for (const url of mediaUrls(stream)) {
      for (const options of [{ method: 'HEAD' }, { range: true }]) {
        try {
          const size = responseSize(await requestMedia(url, { ...options, signal }));
          if (size) return size;
        } catch { checkAbort(signal); }
      }
    }
    throw new Error('服务器未提供可读取的文件大小');
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
        if (videoCodec !== data.codec || audioCodec !== 'aac' || !videoConfig || !audioConfig) {
          throw new Error('下载文件的编码与所选画质不一致。');
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
        const videoSource = new EncodedVideoPacketSource(videoCodec);
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
        worker.postMessage({ video, audio, width: info.video.width, height: info.video.height,
          duration: info.duration, codec: info.codec.mux });
      } catch (error) { finish(error); }
    });
  }

  function save(buffer, name) {
    const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function beginInspection() {
    const route = currentRoute();
    if (!route) return;
    inspection?.controller.abort();
    const state = { key: route.key, kind: route.kind, controller: new AbortController(), info: null, rows: [], busy: true, error: '' };
    inspection = state;
    renderInspection();
    const signal = state.controller.signal;
    try {
      if (route.kind === 'album') {
        const result = await albumInfo(route, signal);
        checkAbort(signal);
        if (inspection === state) Object.assign(state, result);
        return;
      }
      const result = await resolveQualities(route, signal, info => {
        if (inspection !== state || signal.aborted) return;
        state.info = info;
        renderInspection();
      });
      checkAbort(signal);
      Object.assign(state, result);
      renderInspection();
      // 相同音轨只探测一次；最多同时探测两行，避免集中请求 CDN。
      const measurements = new Map();
      const measure = stream => {
        const key = mediaUrls(stream)[0];
        if (!measurements.has(key)) measurements.set(key, probeTrack(stream, signal)
          .then(size => ({ size })).catch(error => ({ error: error.message })));
        return measurements.get(key);
      };
      const queue = [...state.rows];
      const run = async () => {
        while (queue.length) {
          checkAbort(signal);
          const row = queue.shift();
          const [video, audio] = await Promise.all([measure(row.video), measure(row.audio)]);
          checkAbort(signal);
          row.size = video.size && audio.size ? video.size + audio.size : null;
          row.sizeError = [video.error, audio.error].filter(Boolean).join('；');
          row.probing = false;
          if (inspection === state) renderInspection();
        }
      };
      await Promise.all([run(), run()]);
    } catch (error) {
      if (!signal.aborted) state.error = error.message || '读取列表失败，请重试。';
    } finally {
      if (inspection === state && !signal.aborted) {
        state.busy = false;
        renderInspection();
      }
    }
  }

  function renderInspection() {
    const state = inspection;
    const album = (state?.kind || currentRoute()?.kind) === 'album';
    ui.heading.textContent = album ? '下载当前图集' : '下载当前视频';
    ui.panel.setAttribute('aria-label', album ? '哔哩哔哩图集下载' : '哔哩哔哩视频下载');
    ui.launch.title = album ? '点击下载图集原图，拖动调整位置' : '点击选择下载画质，拖动调整位置';
    ui.launch.setAttribute('aria-label', album ? '展开或收起图集下载面板' : '展开或收起视频下载面板');
    ui.column.textContent = album ? '图片' : '画质';
    ui.sizeColumn.textContent = album ? '原图大小（约）' : '大小（含音频）';
    ui.hint.textContent = album ? '按发布顺序下载原图，保留原始格式。打包为一个 ZIP，单次上限 512 MB。'
      : '大小为音视频合计，合并后可能略有差异。单次上限 512 MB。';
    ui.downloadAll.hidden = !album;
    ui.downloadAll.disabled = Boolean(activeTask || state?.busy || !state?.rows.length
      || state.rows.reduce((sum, row) => sum + (row.size || 0), 0) > MAX_BYTES);
    if (album) {
      ui.title.textContent = state?.info?.title || (state?.busy ? '正在读取当前图集…' : '下载动态中的原图');
      ui.details.textContent = state?.info ? `动态 ${state.info.id} · ${state.rows.length} 张原图` : '使用当前网页可访问的动态';
      ui.inspectStatus.textContent = state?.error || (state?.busy ? '正在获取图集原图…'
        : state?.rows.length ? `共 ${state.rows.length} 张图片，可单张下载或全部打包。` : '点击刷新列表，读取当前图集。');
    } else {
      ui.title.textContent = state?.info?.title || (state?.busy ? '正在读取当前视频…' : '选择当前视频的画质');
      ui.details.textContent = state?.info ? `P${state.info.page} · 普通账号可用画质` : '使用当前网页登录状态';
      ui.inspectStatus.textContent = state?.error || (state?.busy
        ? state.rows.length ? '正在读取各画质大小…' : '正在获取可用画质…'
        : state?.rows.length ? `共 ${state.rows.length} 个画质可选${state.incomplete ? '，部分档位解析失败，可刷新重试' : ''}。`
        : '点击刷新列表，读取当前视频的可用画质。');
    }
    ui.refresh.disabled = Boolean(state?.busy || activeTask);
    ui.rows.replaceChildren();
    ui.table.hidden = !state?.rows.length;
    for (const row of state?.rows || []) {
      const tr = document.createElement('tr');
      if (album) tr.dataset.image = String(row.index); else tr.dataset.quality = String(row.qn);
      const quality = document.createElement('td');
      const name = document.createElement('strong'); name.textContent = album ? `第 ${row.index} 张` : qualityName(row.qn);
      const detail = document.createElement('small');
      detail.textContent = album ? `${row.width > 0 && row.height > 0 ? `${row.width} × ${row.height}` : '尺寸未知'} · ${row.extension.toUpperCase()}`
        : `${row.video.width} × ${row.video.height} · ${row.codec.name}`;
      quality.append(name, detail);
      if (album) {
        const link = document.createElement('a');
        link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看原图';
        quality.append(link);
      }
      const size = document.createElement('td');
      size.textContent = row.probing ? '读取中…' : row.size ? bytes(row.size) : '大小未知';
      size.title = album ? '接口提供的原图大小估计，实际以下载文件为准' : row.sizeError || '视频与音频的合计大小，合并后的 MP4 可能略有差异';
      const action = document.createElement('td');
      const button = document.createElement('button'); button.type = 'button';
      const oversized = row.size > MAX_BYTES;
      button.textContent = oversized ? '超过上限' : '下载';
      button.className = 'primary';
      button.disabled = Boolean(activeTask || row.probing || oversized);
      button.setAttribute('aria-label', album ? `下载第 ${row.index} 张原图` : `下载 ${qualityName(row.qn)}`);
      button.addEventListener('click', () => album ? startAlbumDownload(state, row) : startDownload(state, row));
      action.append(button); tr.append(quality, size, action); ui.rows.append(tr);
    }
    placePanel();
  }

  async function startDownload(state, row) {
    if (activeTask || state !== inspection || row.probing || row.size > MAX_BYTES) return;
    if (currentRoute()?.key !== state.key) { syncRoute(); return; }
    const controller = new AbortController();
    // 固定点击时的视频、分 P 和画质；页面切换不会改写正在进行的任务。
    const info = { ...state.info, qn: row.qn, codec: row.codec };
    activeTask = controller;
    ui.task.hidden = false;
    ui.taskTitle.textContent = `${qualityName(row.qn)} · ${info.title}`;
    ui.cancel.hidden = false;
    status('正在更新下载地址…');
    renderInspection();
    const started = performance.now();
    try {
      const play = await playInfo(info, row.qn, controller.signal);
      const selected = qualityRows(play).find(candidate => candidate.qn === row.qn && candidate.codec.id === row.codec.id);
      if (!selected) throw new Error('所选画质已不可用，请刷新画质列表后重试。');
      Object.assign(info, { video: selected.video, audio: audioStream(play) });
      checkAbort(controller.signal);
      const loaded = [0, 0];
      const totals = [0, 0];
      const progress = index => (size, total) => {
        if (controller.signal.aborted) return;
        loaded[index] = size;
        totals[index] = total;
        const sum = loaded[0] + loaded[1];
        if (Math.max(loaded[0], totals[0]) + Math.max(loaded[1], totals[1]) > MAX_BYTES) {
          controller.abort(new Error('音视频合计超过 512 MB 上限，请使用桌面下载器下载这个视频。'));
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
      ui.taskTitle.textContent = name;
      console.info('[Bili1080P] 已生成 MP4', { bvid: info.bvid, cid: info.cid, quality: info.qn,
        size: result.buffer.byteLength, muxSeconds: result.seconds, videoPackets: result.counts[0], audioPackets: result.counts[1] });
    } catch (error) {
      controller.abort(error);
      status(error.name === 'AbortError' ? '已取消下载。' : error.message || '下载失败，请重试。');
    } finally {
      activeTask = null;
      ui.cancel.hidden = true;
      ui.progress.hidden = !ui.progress.hasAttribute('value');
      renderInspection();
      syncRoute();
    }
  }

  async function startAlbumDownload(state, selectedRow = null) {
    if (activeTask || state !== inspection || state?.kind !== 'album' || state.busy || !state.rows.length) return;
    if (currentRoute()?.key !== state.key) { syncRoute(); return; }
    const rows = selectedRow ? [selectedRow] : [...state.rows];
    const info = { ...state.info };
    const controller = new AbortController();
    const signal = controller.signal;
    activeTask = controller;
    ui.task.hidden = false;
    ui.taskTitle.textContent = selectedRow ? albumFilename(info, selectedRow) : albumFilename(info);
    ui.cancel.hidden = false;
    renderInspection();
    let completedBytes = 0;
    try {
      const files = [];
      for (const [index, row] of rows.entries()) {
        checkAbort(signal);
        const progress = (loaded, total) => {
          if (signal.aborted) return;
          if (completedBytes + Math.max(loaded, total) > MAX_BYTES) {
            controller.abort(new Error('图片合计超过 512 MB 上限，请分张下载或使用桌面下载器。'));
            return;
          }
          status(`正在下载第 ${row.index} 张 · ${index + 1} / ${rows.length} · ${bytes(completedBytes + loaded)}`,
            (index + (total ? loaded / total : 0)) / rows.length * (selectedRow ? 1 : 0.9));
        };
        progress(0, row.size || 0);
        const blob = await requestBlob(row.url, signal, progress, 'image');
        checkAbort(signal);
        completedBytes += blob.size;
        if (selectedRow) save(blob, albumFilename(info, row));
        else files.push({ name: albumFilename(info, row), blob });
      }
      if (!selectedRow) {
        status('正在打包图集…', 0.9);
        const result = await packAlbum(files, signal);
        checkAbort(signal);
        save(new Blob([result.buffer], { type: 'application/zip' }), albumFilename(info));
        console.info('[Bili1080P] 已生成图集 ZIP', { id: info.id, images: rows.length,
          size: result.buffer.byteLength, packSeconds: result.seconds });
      }
      status(`已交给浏览器保存 · ${rows.length} 张原图 · ${bytes(completedBytes)}`, 1);
    } catch (error) {
      controller.abort(error);
      status(error.name === 'AbortError' ? '已取消下载。' : error.message || '图集下载失败，请重试。');
    } finally {
      activeTask = null;
      ui.cancel.hidden = true;
      ui.progress.hidden = !ui.progress.hasAttribute('value');
      renderInspection();
      syncRoute();
    }
  }

  function zipWorkerMain() {
    self.onmessage = async ({ data }) => {
      const started = performance.now();
      try {
        const zip = new JSZip();
        for (const file of data.files) zip.file(file.name, new Uint8Array(await file.blob.arrayBuffer()));
        let lastUpdate = 0;
        const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE', streamFiles: true }, metadata => {
          if (performance.now() - lastUpdate > 100 || metadata.percent === 100) {
            self.postMessage({ type: 'progress', ratio: metadata.percent / 100 });
            lastUpdate = performance.now();
          }
        });
        self.postMessage({ type: 'done', buffer, seconds: (performance.now() - started) / 1000 }, [buffer]);
      } catch (error) {
        self.postMessage({ type: 'error', message: error.message || '图集打包失败。' });
      }
    };
  }

  function packAlbum(files, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const library = GM_getResourceText('BiliZip');
      if (!library) throw new Error('图集打包组件未加载，请重新安装脚本后重试。');
      const url = URL.createObjectURL(new Blob([library, '\n;(', zipWorkerMain.toString(), ')();'], { type: 'text/javascript' }));
      let worker;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        worker?.terminate();
        URL.revokeObjectURL(url);
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => finish(signal.reason || abortError());
      const timeout = setTimeout(() => finish(new Error('图集打包超时，请分张下载或重试。')), 120000);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        worker = new Worker(url);
        worker.onerror = () => finish(new Error('无法启动图集打包组件，请重新安装脚本后重试。'));
        worker.onmessage = ({ data }) => {
          if (settled) return;
          if (data.type === 'progress') status('正在打包图集…', 0.9 + data.ratio * 0.1);
          if (data.type === 'error') finish(new Error(data.message));
          if (data.type === 'done') finish(null, data);
        };
        worker.postMessage({ files });
      } catch (error) { finish(error); }
    });
  }

  function status(message, ratio = null) {
    ui.status.textContent = message;
    if (ratio === null) ui.progress.removeAttribute('value');
    else ui.progress.value = Math.max(0, Math.min(ratio, 1));
    ui.progress.hidden = !activeTask && ratio !== 1;
    placePanel();
  }

  function enableIconDragging(button, onMoved) {
    const stored = GM_getValue('download-icon-position', null);
    let position = stored && [stored.x, stored.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
      ? { x: stored.x, y: stored.y } : null;
    let drag = null;
    let suppressClick = false;
    const bounds = () => ({ left: 8, top: 8, right: Math.max(8, innerWidth - 56), bottom: Math.max(8, innerHeight - 56) });
    const place = (left, top) => {
      const b = bounds();
      const x = Math.max(b.left, Math.min(left, b.right));
      const y = Math.max(b.top, Math.min(top, b.bottom));
      button.style.left = `${x}px`; button.style.top = `${y}px`;
      return { x: b.right > b.left ? (x - b.left) / (b.right - b.left) : 0,
        y: b.bottom > b.top ? (y - b.top) / (b.bottom - b.top) : 0 };
    };
    const update = () => {
      if (drag) return;
      const b = bounds();
      place(position ? b.left + position.x * (b.right - b.left) : innerWidth - 72,
        position ? b.top + position.y * (b.bottom - b.top) : innerHeight - 132);
      onMoved();
    };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.stopPropagation();
      const box = button.getBoundingClientRect();
      suppressClick = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.left, top: box.top, moved: false };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true; suppressClick = true;
      event.preventDefault(); event.stopPropagation();
      place(drag.left + dx, drag.top + dy); onMoved();
    });
    const finish = (event, cancelled) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      if (moved && !cancelled) {
        position = place(parseFloat(button.style.left), parseFloat(button.style.top));
        GM_setValue('download-icon-position', position);
      }
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      if (moved) { event.preventDefault(); event.stopPropagation(); }
    };
    button.addEventListener('pointerup', event => finish(event, false));
    button.addEventListener('pointercancel', event => finish(event, true));
    button.addEventListener('lostpointercapture', event => finish(event, true));
    addEventListener('resize', update);
    return { update, ignoreClick: event => event.detail !== 0 && suppressClick };
  }

  function placePanel() {
    if (!ui || ui.panel.hidden) return;
    const { panel, launch } = ui;
    const icon = launch.getBoundingClientRect();
    const edge = 8, gap = 10;
    const down = icon.top + icon.height / 2 <= innerHeight / 2;
    const available = down ? innerHeight - icon.bottom - gap - edge : icon.top - gap - edge;
    // 面板内容变长时在可用一侧内部滚动，保持图标始终可点击、可拖动。
    panel.style.maxHeight = `${Math.max(0, available)}px`;
    const width = panel.offsetWidth, height = panel.offsetHeight;
    const left = Math.max(edge, Math.min(icon.left + icon.width / 2 - width / 2, innerWidth - width - edge));
    const below = icon.bottom + gap, above = icon.top - gap - height;
    const maxTop = Math.max(edge, innerHeight - height - edge);
    let top = down ? below : above;
    if (top < edge || top > maxTop) {
      const other = down ? above : below;
      if (other >= edge && other <= maxTop) top = other;
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(edge, Math.min(top, maxTop))}px`;
  }

  function setPanelOpen(open) {
    ui.panel.hidden = !open;
    ui.launch.setAttribute('aria-expanded', String(open));
    placePanel();
  }

  function mount() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial;position:fixed;left:0;top:0;z-index:2147483646;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172b3a}
        *{box-sizing:border-box}[hidden]{display:none!important}
        button{font:inherit;cursor:pointer;border:0;border-radius:9px;padding:8px 12px;background:#eef3f7;color:#26465d}
        button:focus-visible{outline:3px solid #73cfff;outline-offset:3px}button:disabled{cursor:default;opacity:.55}
        .primary{background:#008ac5;color:white;font-weight:600}.primary:hover:enabled{background:#0078ab}
        #launch{position:fixed;width:48px;height:48px;display:grid;place-items:center;box-shadow:0 4px 18px #001b3b33;border:1px solid #ffffff88;border-radius:50%;padding:0;touch-action:none;user-select:none;cursor:grab}
        #launch:active{cursor:grabbing}#launch svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
        section{position:fixed;left:0;top:0;width:min(440px,calc(100vw - 16px));max-height:calc(100vh - 80px);overflow:auto;background:#fff;border:1px solid #deebf3;border-radius:16px;box-shadow:0 12px 48px #001b3b26;padding:18px}
        header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}header strong{font-size:16px}#close{padding:2px 8px;background:transparent;font-size:22px;color:#758796}
        #title{font-weight:600;line-height:1.6;overflow-wrap:anywhere;max-height:76px;overflow:auto}
        #details,.hint,small{color:#688093;font-size:12px;line-height:1.6}#details{margin-top:5px}small{display:block}p{margin:10px 0}
        a{color:#008ac5;font-size:12px}#downloadAll{margin-right:8px}
        table{width:100%;border-collapse:collapse;table-layout:fixed;margin:12px 0}th,td{text-align:left;border-bottom:1px solid #e6eef4;padding:10px 4px;font-size:13px;overflow-wrap:anywhere}th{color:#688093;font-weight:500}th:first-child{width:46%}th:nth-child(2){width:29%}td:last-child{text-align:right}td button{white-space:nowrap;font-size:12px;padding:7px 10px}
        #task{border-top:1px solid #e6eef4;margin-top:14px;padding-top:12px}#taskTitle{font-size:12px;color:#688093;overflow-wrap:anywhere;max-height:60px;overflow:auto}#status{line-height:1.7;margin:10px 0;overflow-wrap:anywhere}
        progress{width:100%;height:7px;accent-color:#008ac5;display:block;margin:12px 0}footer{display:flex;gap:8px;margin-top:10px}
      </style>
      <section id="panel" hidden aria-label="哔哩哔哩视频下载">
        <header><strong id="heading">下载当前视频</strong><button id="close" type="button" aria-label="收起下载面板">×</button></header>
        <div id="title">选择当前视频的画质</div><div id="details">使用当前网页登录状态</div>
        <p id="inspectStatus" role="status" class="hint"></p>
        <p id="hint" class="hint">大小为音视频合计，合并后可能略有差异。单次上限 512 MB。</p>
        <button id="downloadAll" class="primary" type="button" hidden>下载全部原图（ZIP）</button>
        <button id="refresh" type="button">刷新列表</button>
        <div id="task" hidden><div id="taskTitle"></div><div id="status" role="status" aria-live="polite"></div>
          <progress id="progress" max="1" hidden></progress><footer><button id="cancel" type="button" hidden>取消下载</button></footer>
        </div>
        <table id="table" hidden><thead><tr><th id="column" scope="col">画质</th><th id="sizeColumn" scope="col">大小（含音频）</th><th scope="col">操作</th></tr></thead><tbody id="rows"></tbody></table>
      </section>
      <button id="launch" type="button" class="primary" title="点击选择下载画质，拖动调整位置" aria-label="展开或收起视频下载面板" aria-expanded="false" aria-controls="panel">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></svg>
      </button>`;
    document.documentElement.append(host);
    const elements = { host };
    for (const id of ['panel', 'title', 'details', 'inspectStatus', 'table', 'rows', 'refresh', 'task', 'taskTitle',
      'status', 'progress', 'cancel', 'launch', 'close', 'heading', 'column', 'sizeColumn', 'hint', 'downloadAll']) elements[id] = shadow.getElementById(id);
    elements.refresh.addEventListener('click', beginInspection);
    elements.downloadAll.addEventListener('click', () => startAlbumDownload(inspection));
    elements.cancel.addEventListener('click', () => activeTask?.abort(abortError()));
    elements.close.addEventListener('click', () => setPanelOpen(false));
    return elements;
  }

  function syncRoute() {
    const route = currentRoute();
    ui.host.style.display = route || activeTask ? 'block' : 'none';
    const key = route?.key || '';
    if (key === routeKey) return;
    routeKey = key;
    inspection?.controller.abort();
    inspection = null;
    setPanelOpen(false);
    renderInspection();
  }

  const ui = mount();
  const dragging = enableIconDragging(ui.launch, placePanel);
  ui.launch.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (dragging.ignoreClick(event)) return;
    syncRoute();
    setPanelOpen(ui.panel.hidden);
    if (!ui.panel.hidden && !inspection && currentRoute()) void beginInspection();
  });
  new ResizeObserver(placePanel).observe(ui.panel);
  dragging.update();
  syncRoute();
  setInterval(syncRoute, 500);
})();
