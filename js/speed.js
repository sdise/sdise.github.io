/* =========================================================
 * 网络测速仪 —— 纯浏览器端实现
 * 分区：工具 / 图表 / 延迟 / 下载 / 上传 / 诊断 / 报告 / 初始化
 * ========================================================= */
(function () {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  const MB = 1048576;
  const el = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const HTTP_PORTS = new Set([80, 8000, 8080, 8888, 3000, 3128]);
  const PAGE_SECURE = location.protocol === 'https:';

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ } }
  };

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '--';
    return (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';
  }
  function fmtBytes(b) {
    if (!isFinite(b)) return '--';
    if (b >= 1024 * MB) return (b / 1024 / MB).toFixed(2) + ' GB';
    if (b >= MB) return (b / MB).toFixed(2) + ' MB';
    return (b / 1024).toFixed(1) + ' KB';
  }
  function fmtSpeed(bytesPerSec) {
    if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '--';
    if (state.unit === 'mbs') return (bytesPerSec / MB).toFixed(2) + ' MB/s';
    const m = bytesPerSec * 8 / 1e6;
    return m >= 1000 ? (m / 1000).toFixed(2) + ' Gbps' : m.toFixed(1) + ' Mbps';
  }
  function setStatus(id, text, kind) {
    const n = el(id);
    n.textContent = text;
    n.className = 'status' + (kind ? ' ' + kind : '');
  }
  function setDisabled(id, disabled) { const n = el(id); if (n) n.disabled = !!disabled; }

  /* ---------------- 全局状态 ---------------- */
  const state = {
    unit: 'mbps',
    theme: store.get('sdise-speed-theme', 'auto'),
    ip: null,
    lat: { running: false, abort: false, list: [], done: [] },
    dl: { running: false, abort: false, ctrls: [], meter: null, lastInst: 0, reqs: 0 },
    up: { running: false, abort: false, ctrls: [], meter: null, lastInst: 0, reqs: 0 },
    history: store.get('sdise-speed-history', []),
    lastDiag: '',
    lastResult: { dl: '', up: '' }
  };
  const snapshots = { dl: null, up: null };

  function Meter() {
    return {
      bytes: 0, start: 0, lastT: 0, lastB: 0, peak: 0, samples: 0,
      markStart(t) { if (!this.start) this.start = t; },
      add(n) { this.bytes += n; },
      tick(t) {
        if (!this.start) return null;
        if (!this.lastT) { this.lastT = t; this.lastB = this.bytes; return null; }
        const dt = (t - this.lastT) / 1000;
        if (dt < 0.08) return null;
        const inst = (this.bytes - this.lastB) / dt;
        this.lastT = t; this.lastB = this.bytes; this.samples++;
        if (this.samples > 1 && inst > this.peak) this.peak = inst;
        return inst;
      },
      elapsed(t) { return this.start ? (t - this.start) / 1000 : 0; },
      avg(t) { const e = this.elapsed(t); return e > 0 ? this.bytes / e : 0; }
    };
  }

  /* ---------------- 图表（Chart.js + 内置兜底） ---------------- */
  const series = { labels: [], data: [] };   // data 单位统一为 Mbps
  let chartInst = null;

  function cssVar(n, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v || fallback || '#3b82f6';
  }
  function unitLabel() { return state.unit === 'mbs' ? '速度 (MB/s)' : '速度 (Mbps)'; }
  function convertPoint(mbps) { return state.unit === 'mbs' ? mbps * 1e6 / 8 / MB : mbps; }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = () => rej(new Error('load fail'));
      document.head.appendChild(s);
    });
  }
  async function ensureChart() {
    if (window.Chart) return true;
    const cdns = [
      'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
      'https://unpkg.com/chart.js@4.4.1/dist/chart.umd.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
    ];
    for (let i = 0; i < cdns.length; i++) {
      try { await loadScript(cdns[i]); if (window.Chart) return true; } catch (e) { /* 换下一个源 */ }
    }
    return false;
  }

  function resetSeries() { series.labels.length = 0; series.data.length = 0; }

  function buildChart() {
    const canvas = el('speedChart');
    if (!canvas) return;
    if (chartInst) { chartInst.destroy(); chartInst = null; }
    if (window.Chart) {
      const accent = cssVar('--accent', '#3b82f6');
      const grid = cssVar('--border', '#e2e8f0');
      const text = cssVar('--muted', '#64748b');
      chartInst = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: series.labels.slice(),
          datasets: [{
            label: unitLabel(),
            data: series.data.map(convertPoint),
            borderColor: accent,
            backgroundColor: 'rgba(59,130,246,.16)',
            borderWidth: 2.5, tension: 0.28, fill: true, pointRadius: 0
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: {
            x: { title: { display: true, text: '时间 (秒)', color: text }, ticks: { color: text, maxTicksLimit: 10 }, grid: { color: grid } },
            y: { beginAtZero: true, title: { display: true, text: unitLabel(), color: text }, ticks: { color: text }, grid: { color: grid } }
          },
          plugins: { legend: { display: false } }
        }
      });
      el('chartNote').hidden = true;
    } else {
      el('chartNote').hidden = false;
      drawFallback();
    }
  }

  function pushPoint(tSec, bytesPerSec) {
    series.labels.push(tSec.toFixed(1));
    series.data.push(bytesPerSec * 8 / 1e6);
    if (series.data.length > 300) { series.labels.shift(); series.data.shift(); }
    if (chartInst) {
      chartInst.data.labels = series.labels;
      chartInst.data.datasets[0].data = series.data.map(convertPoint);
      chartInst.data.datasets[0].label = unitLabel();
      chartInst.options.scales.y.title.text = unitLabel();
      chartInst.update('none');
    } else {
      drawFallback();
    }
  }

  /** Chart.js 不可用时的轻量折线图 */
  function drawFallback() {
    const canvas = el('speedChart');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 260;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 54, r: 14, t: 12, b: 28 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const data = series.data.map(convertPoint);
    let max = 0;
    for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
    max = max > 0 ? max * 1.15 : 10;

    ctx.font = '11px system-ui';
    ctx.fillStyle = cssVar('--muted', '#64748b');
    ctx.strokeStyle = cssVar('--border', '#e2e8f0');
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ih - (ih * i / 4);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + iw, y); ctx.stroke();
      ctx.fillText((max * i / 4).toFixed(1), 6, y + 4);
    }
    if (data.length < 2) {
      ctx.fillText('等待数据…', pad.l + 12, pad.t + ih / 2);
      return;
    }
    const stepX = iw / (data.length - 1);
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pad.l + i * stepX;
      const y = pad.t + ih - (data[i] / max) * ih;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = cssVar('--accent', '#3b82f6');
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(pad.l + iw, pad.t + ih);
    ctx.lineTo(pad.l, pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = 'rgba(59,130,246,.15)';
    ctx.fill();
    ctx.fillStyle = cssVar('--muted', '#64748b');
    ctx.fillText('0 s', pad.l, h - 8);
    ctx.fillText(series.labels[series.labels.length - 1] + ' s', pad.l + iw - 34, h - 8);
  }

  /* ---------------- 资源计时（分段耗时） ---------------- */
  function findTiming(url, fromIndex) {
    let list;
    try { list = performance.getEntriesByType('resource'); } catch (e) { return null; }
    for (let i = list.length - 1; i >= 0 && i >= fromIndex; i--) {
      if (list[i].name === url) {
        const e = list[i];
        return {
          dns: e.domainLookupEnd > 0 ? e.domainLookupEnd - e.domainLookupStart : null,
          tcp: e.connectEnd > 0 ? e.connectEnd - e.connectStart : null,
          tls: (e.secureConnectionStart > 0 && e.connectEnd > 0) ? e.connectEnd - e.secureConnectionStart : null,
          ttfb: e.responseStart > 0 ? e.responseStart - (e.requestStart || e.startTime) : null,
          total: e.duration,
          proto: e.nextHopProtocol || '',
          full: e.connectEnd > 0      // 只有响应了 Timing-Allow-Origin 时才有分段
        };
      }
    }
    return null;
  }
  function timingText(t) {
    if (!t) return '仅往返';
    if (t.full) {
      return 'DNS ' + fmtMs(t.dns) + ' · TCP ' + fmtMs(t.tcp) + ' · TLS ' + fmtMs(t.tls) +
        ' · TTFB ' + fmtMs(t.ttfb) + (t.proto ? ' · ' + t.proto : '');
    }
    return '仅往返（无 TAO 分段）' + (t.proto ? ' · ' + t.proto : '');
  }
  function describeError(e, proto) {
    if (!e) return '未知错误';
    if (e.name === 'AbortError') return '超时';
    const msg = e.message || String(e);
    if (proto === 'http' && PAGE_SECURE) return 'HTTPS 页面禁止 http 明文请求';
    if (/certificate|ssl|tls/i.test(msg)) return '证书错误';
    return '连接失败';
  }

  /* ---------------- 延迟 / 抖动 ---------------- */
  const PRESETS = {
    cdn: ['1.1.1.1:443', '8.8.8.8:443', '223.5.5.5:443', '119.29.29.29:443'],
    cn: ['baidu.com:443', 'qq.com:443', 'taobao.com:443', 'aliyun.com:443', 'zhihu.com:443'],
    global: ['cloudflare.com:443', 'github.com:443', 'wikipedia.org:443', 'speed.cloudflare.com:443']
  };

  function parseTarget(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let m = s.match(/^\[([^\]]+)\](?::(\d+))?$/);           // [ipv6]:port
    if (m) return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 443, display: m[1] + ':' + (m[2] || 443) };
    m = s.match(/^([^:]+):(\d+)$/);                          // host:port
    if (m) return { host: m[1], port: parseInt(m[2], 10), display: s };
    if (s.indexOf(':') > -1 && s.indexOf(':') !== s.lastIndexOf(':')) {
      return { host: s, port: 443, display: s + ':443' };    // 裸 IPv6
    }
    return { host: s, port: 443, display: s + ':443' };
  }
  const urlHost = (h) => (h.indexOf(':') > -1 && h.charAt(0) !== '[' ? '[' + h + ']' : h);

  async function probeOnce(t, proto, timeout) {
    const url = proto + '://' + urlHost(t.host) + ':' + t.port + '/?_=' +
      Math.random().toString(36).slice(2) + Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* noop */ } }, timeout);
    let from = 0;
    try { from = performance.getEntriesByType('resource').length; } catch (e) { from = 0; }
    const t0 = performance.now();
    try {
      // no-cors + HEAD：只握手、只读响应头，不下载正文
      await fetch(url, {
        method: 'HEAD', mode: 'no-cors', cache: 'no-store',
        credentials: 'omit', redirect: 'follow', signal: ctrl.signal
      });
      return { ok: true, ms: performance.now() - t0, timing: findTiming(url, from) };
    } catch (e) {
      return { ok: false, error: describeError(e, proto) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function probeTarget(raw, opt) {
    const t = parseTarget(raw);
    if (!t) return { target: raw, ok: false, error: '格式错误' };

    let protos;
    if (opt.proto !== 'auto') protos = [opt.proto];
    else if (PAGE_SECURE) protos = ['https'];
    else protos = HTTP_PORTS.has(t.port) ? ['http', 'https'] : ['https', 'http'];

    const errs = {};
    for (let i = 0; i < protos.length; i++) {
      const p = protos[i];
      const first = await probeOnce(t, p, opt.timeout);
      if (!first.ok) { errs[p] = first.error; continue; }

      const samples = [first.ms];
      let timing = first.timing;
      for (let k = 1; k < opt.times; k++) {
        if (state.lat.abort) break;
        const r = await probeOnce(t, p, opt.timeout);
        if (r.ok) {
          samples.push(r.ms);
          if (!timing || (r.timing && r.timing.full)) timing = r.timing;
        }
        await sleep(120);
      }
      const n = samples.length;
      const min = Math.min.apply(null, samples);
      const max = Math.max.apply(null, samples);
      const avg = samples.reduce((a, b) => a + b, 0) / n;
      const jitter = samples.reduce((a, b) => a + Math.abs(b - avg), 0) / n;
      return {
        target: raw, display: t.display, ok: true, proto: p,
        min: min, avg: avg, max: max, jitter: jitter,
        rate: Math.round(n / opt.times * 100), timing: timing
      };
    }
    return { target: raw, display: t.display, ok: false, error: errs.https || errs.http || '连接失败' };
  }

  function renderLatency() {
    const tbody = el('latTable').querySelector('tbody');
    const done = state.lat.done.slice().sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return a.ok ? a.avg - b.avg : 0;
    });
    const rows = done.map((r) => {
      if (!r.ok) {
        return '<tr><td>' + esc(r.target) + '</td><td class="num">--</td><td class="num">--</td>' +
          '<td class="num">--</td><td class="num">--</td><td class="num">--</td>' +
          '<td class="detail">--</td><td class="bad">✖ ' + esc(r.error) + '</td></tr>';
      }
      return '<tr><td>' + esc(r.target) + '</td>' +
        '<td class="num ok">' + fmtMs(r.min) + '</td>' +
        '<td class="num">' + fmtMs(r.avg) + '</td>' +
        '<td class="num">' + fmtMs(r.max) + '</td>' +
        '<td class="num">' + fmtMs(r.jitter) + '</td>' +
        '<td class="num">' + r.rate + '%</td>' +
        '<td class="detail">' + esc(timingText(r.timing)) + '</td>' +
        '<td class="ok">✔ 通</td></tr>';
    });
    if (state.lat.running) {
      const seen = {};
      done.forEach((d) => { seen[d.target] = 1; });
      state.lat.list.forEach((t) => {
        if (!seen[t]) {
          rows.push('<tr><td>' + esc(t) + '</td><td class="num">--</td><td class="num">--</td>' +
            '<td class="num">--</td><td class="num">--</td><td class="num">--</td>' +
            '<td class="detail">--</td><td>排队中…</td></tr>');
        }
      });
    }
    tbody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="8" class="empty">暂无数据</td></tr>';
  }

  async function runLatency() {
    if (state.lat.running) return;
    const lines = el('latTargets').value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { setStatus('latStatus', '请先填写目标（host:port）', 'warn'); return; }

    const opt = {
      times: clampInt(el('latTimes').value, 1, 20, 5),
      timeout: clampInt(el('latTimeout').value, 500, 15000, 4000),
      proto: el('latProto').value,
      conc: clampInt(el('latConc').value, 1, 16, 4)
    };
    state.lat = { running: true, abort: false, list: lines, done: [] };
    setDisabled('btnLatStart', true);
    setDisabled('btnLatStop', false);
    setStatus('latStatus', '测试中 … 0/' + lines.length);
    renderLatency();

    const queue = lines.slice();
    async function worker() {
      while (queue.length) {
        if (state.lat.abort) break;
        const raw = queue.shift();
        const r = await probeTarget(raw, opt);
        state.lat.done.push(r);
        renderLatency();
        setStatus('latStatus', '测试中 … ' + state.lat.done.length + '/' + lines.length);
      }
    }
    const ws = [];
    for (let i = 0; i < Math.min(opt.conc, queue.length); i++) ws.push(worker());
    await Promise.all(ws);

    state.lat.running = false;
    setDisabled('btnLatStart', false);
    setDisabled('btnLatStop', true);
    renderLatency();

    const okCount = state.lat.done.filter((r) => r.ok).length;
    setStatus('latStatus', state.lat.abort
      ? '已停止（完成 ' + state.lat.done.length + ' 个）'
      : '完成：' + okCount + '/' + state.lat.done.length + ' 通，按平均延迟排序',
      okCount ? 'ok' : 'warn');

    if (okCount) {
      const best = state.lat.done.filter((r) => r.ok)
        .reduce((a, b) => (a.avg <= b.avg ? a : b));
      pushHistory({
        type: '延迟',
        summary: '最快 ' + best.target + ' ' + fmtMs(best.avg),
        detail: lines.join(', ')
      });
    }
  }

  /* ---------------- 读数面板 ---------------- */
  function paint(p, s) {
    snapshots[p] = s;
    el(p + 'Current').textContent = fmtSpeed(s.cur);
    el(p + 'Avg').textContent = fmtSpeed(s.avg);
    el(p + 'Peak').textContent = fmtSpeed(s.peak);
    el(p + 'Total').textContent = fmtBytes(s.bytes);
    if (el(p + 'Elapsed')) el(p + 'Elapsed').textContent = s.elapsed ? s.elapsed.toFixed(1) + ' s' : '--';
    if (el(p + 'Ttfb')) el(p + 'Ttfb').textContent = fmtMs(s.ttfb);
    if (el(p + 'Reqs')) el(p + 'Reqs').textContent = s.reqs || '--';
    const prog = s.maxSec
      ? Math.min(1, Math.max(s.elapsed / s.maxSec, s.expected ? s.bytes / s.expected : 0))
      : (s.expected ? Math.min(1, s.bytes / s.expected) : 0);
    if (el(p + 'Bar')) el(p + 'Bar').style.width = (prog * 100).toFixed(1) + '%';
  }
  function resetReadouts(p) {
    paint(p, { cur: 0, avg: 0, peak: 0, bytes: 0, elapsed: 0, ttfb: null, reqs: 0, expected: 0, maxSec: 0 });
    ['Current', 'Avg', 'Peak'].forEach((k) => { el(p + k).textContent = '--'; });
  }
  function snapshotOf(st, t, ctx) {
    return {
      cur: st.lastInst || 0,
      avg: st.meter.avg(t),
      peak: st.meter.peak,
      bytes: st.meter.bytes,
      elapsed: st.meter.elapsed(t),
      ttfb: ctx.ttfb,
      reqs: st.reqs || 0,
      expected: ctx.expected || 0,
      maxSec: ctx.maxSec || 0
    };
  }
  function startSampler(st, p, ctx, onTimeout) {
    return setInterval(() => {
      const t = performance.now();
      const inst = st.meter.tick(t);
      if (inst != null) { st.lastInst = inst; pushPoint(st.meter.elapsed(t), inst); }
      paint(p, snapshotOf(st, t, ctx));
      if (!st.abort && ctx.maxSec && st.meter.elapsed(t) >= ctx.maxSec) onTimeout();
    }, 250);
  }
  function abortAll(st) {
    st.abort = true;
    st.ctrls.forEach((c) => { try { c.abort(); } catch (e) { /* noop */ } });
  }

  /* ---------------- 下载 ---------------- */
  function withBytes(url, bytes) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.set('bytes', String(bytes));
      u.searchParams.set('_', Math.random().toString(36).slice(2));
      return u.toString();
    } catch (e) {
      return url + (url.indexOf('?') > -1 ? '&' : '?') + 'bytes=' + bytes;
    }
  }

  async function dlStream(url, st, t0) {
    const ctrl = new AbortController();
    st.ctrls.push(ctrl);
    let from = 0;
    try { from = performance.getEntriesByType('resource').length; } catch (e) { from = 0; }
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', mode: 'cors', credentials: 'omit' });
      if (!res.ok && res.status !== 0) throw new Error('HTTP ' + res.status);
      const nowT = performance.now();
      st.meter.markStart(nowT);                       // 计时从首字节到达开始
      if (st.ttfb == null) st.ttfb = nowT - t0;
      const tm = findTiming(url, from);
      if (tm) { st.proto = tm.proto || st.proto || ''; if (tm.ttfb != null && st.ttfbFine == null) st.ttfbFine = tm.ttfb; }
      const reader = res.body.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (st.abort) { try { await reader.cancel(); } catch (e) { /* noop */ } break; }
        st.meter.add(r.value.length);
      }
    } catch (e) {
      if (!st.abort && (!e || e.name !== 'AbortError')) st.error = describeError(e, 'https');
    }
  }

  async function runDownload() {
    if (state.dl.running) return;
    const base = el('dlUrl').value.trim();
    if (!base) { setStatus('dlStatus', '请填写测速地址', 'warn'); return; }
    const streams = parseInt(el('dlStreams').value, 10) || 4;
    const perBytes = clampInt(el('dlBytes').value, 1, 500, 25) * MB;
    const maxSec = clampInt(el('dlTime').value, 3, 60, 10);

    state.dl = { running: true, abort: false, ctrls: [], meter: Meter(), lastInst: 0, reqs: 0, ttfb: null, proto: '' };
    const st = state.dl;
    resetSeries(); buildChart(); resetReadouts('dl');
    setDisabled('btnDlStart', true); setDisabled('btnDlStop', false);
    setStatus('dlStatus', '连接中…');

    const ctx = { ttfb: null, expected: perBytes * streams, maxSec: maxSec };
    const t0 = performance.now();
    const tasks = [];
    for (let i = 0; i < streams; i++) tasks.push(dlStream(withBytes(base, perBytes), st, t0));

    const sampler = startSampler(st, 'dl', ctx, () => {
      abortAll(st);
      setStatus('dlStatus', '达到时长上限，正在收尾…', 'warn');
    });

    try { await Promise.allSettled(tasks); } finally { clearInterval(sampler); }

    const t = performance.now();
    ctx.ttfb = st.ttfbFine != null ? st.ttfbFine : st.ttfb;
    const snap = snapshotOf(st, t, ctx);
    paint('dl', snap);
    state.dl.running = false;
    setDisabled('btnDlStart', false); setDisabled('btnDlStop', true);

    if (st.meter.bytes === 0) {
      setStatus('dlStatus', '测速失败：' + (st.error || '未收到数据（多半是目标不支持 CORS）'), 'bad');
      return;
    }
    const line = '平均 ' + fmtSpeed(snap.avg) + ' · 峰值 ' + fmtSpeed(snap.peak) +
      ' · ' + fmtBytes(snap.bytes) + ' · ' + snap.elapsed.toFixed(1) + ' s · ' +
      streams + ' 并发' + (st.proto ? ' · ' + st.proto : '') +
      ' · 首字节 ' + fmtMs(ctx.ttfb);
    state.lastResult.dl = line;
    setStatus('dlStatus', (st.abort ? '已停止 · ' : '完成 · ') + line, st.abort ? 'warn' : 'ok');
    pushHistory({ type: '下载', summary: fmtSpeed(snap.avg), detail: streams + ' 并发 · ' + base });
  }

  /* ---------------- 上传 ---------------- */
  function randomBuffer(size) {
    const buf = new Uint8Array(size);
    const block = 65536;                 // crypto.getRandomValues 单次上限 64KB
    for (let i = 0; i < size; i += block) {
      crypto.getRandomValues(buf.subarray(i, Math.min(i + block, size)));
    }
    return buf;
  }

  async function upWorker(url, payload, st, maxSec) {
    while (!st.abort && st.meter.elapsed(performance.now()) < maxSec) {
      const ctrl = new AbortController();
      st.ctrls.push(ctrl);
      const t0 = performance.now();
      try {
        // body 用 ArrayBuffer：浏览器不会附加 Content-Type，避免触发预检
        await fetch(url, { method: 'POST', body: payload, mode: 'cors', credentials: 'omit', signal: ctrl.signal });
        st.meter.markStart(t0);
        st.meter.add(payload.byteLength);
        st.reqs++;
      } catch (e) {
        if (!st.abort && (!e || e.name !== 'AbortError')) { st.error = describeError(e, 'https'); break; }
      }
    }
  }

  async function runUpload() {
    if (state.up.running) return;
    const url = el('upUrl').value.trim();
    if (!url) { setStatus('upStatus', '请填写上传端点', 'warn'); return; }
    const chunk = clampInt(el('upChunk').value, 1, 32, 4) * MB;
    const streams = parseInt(el('upStreams').value, 10) || 1;
    const maxSec = clampInt(el('upTime').value, 3, 60, 10);

    let payload;
    try { payload = randomBuffer(chunk); } catch (e) { setStatus('upStatus', '无法生成测试数据', 'bad'); return; }

    state.up = { running: true, abort: false, ctrls: [], meter: Meter(), lastInst: 0, reqs: 0 };
    const st = state.up;
    resetSeries(); buildChart(); resetReadouts('up');
    setDisabled('btnUpStart', true); setDisabled('btnUpStop', false);
    setStatus('upStatus', '上传中…');

    const ctx = { ttfb: null, expected: 0, maxSec: maxSec };
    const sampler = startSampler(st, 'up', ctx, () => {
      abortAll(st);
      setStatus('upStatus', '达到时长上限，正在收尾…', 'warn');
    });

    const tasks = [];
    for (let i = 0; i < streams; i++) tasks.push(upWorker(url, payload, st, maxSec));
    try { await Promise.allSettled(tasks); } finally { clearInterval(sampler); }

    const t = performance.now();
    const snap = snapshotOf(st, t, ctx);
    paint('up', snap);
    state.up.running = false;
    setDisabled('btnUpStart', false); setDisabled('btnUpStop', true);

    if (st.meter.bytes === 0) {
      setStatus('upStatus', '上传失败：' + (st.error || '无数据（端点需允许跨域 POST）'), 'bad');
      return;
    }
    const line = '平均 ' + fmtSpeed(snap.avg) + ' · 峰值 ' + fmtSpeed(snap.peak) +
      ' · ' + fmtBytes(snap.bytes) + ' · ' + snap.elapsed.toFixed(1) + ' s · ' +
      st.reqs + ' 次请求 · 单次 ' + (chunk / MB) + ' MB';
    state.lastResult.up = line;
    setStatus('upStatus', (st.abort ? '已停止 · ' : '完成 · ') + line, st.abort ? 'warn' : 'ok');
    pushHistory({ type: '上传', summary: fmtSpeed(snap.avg), detail: streams + ' 并发 · ' + url });
  }

  /* ---------------- IP / 环境信息 ---------------- */
  function renderIp(failed) {
    const i = state.ip;
    if (failed || !i) {
      el('ovIp').textContent = failed ? '获取失败' : '--';
      el('ovAsn').textContent = '--';
      el('ovLoc').textContent = '--';
      return;
    }
    el('ovIp').textContent = i.ip || '--';
    el('ovAsn').textContent = [i.asn, i.org].filter(Boolean).join(' ') || '--';
    const loc = [i.country, i.region, i.city].filter((v, k, a) => v && a.indexOf(v) === k).join(' / ');
    el('ovLoc').textContent = loc || '--';
  }

  async function fetchIp() {
    el('ovIp').textContent = '获取中…';
    const apis = [
      { url: 'https://ipapi.co/json/', parse: (d) => ({ ip: d.ip, asn: d.asn ? 'AS' + d.asn : '', org: d.org, city: d.city, region: d.region, country: d.country_name }) },
      { url: 'https://ipwho.is/', parse: (d) => ({ ip: d.ip, asn: d.connection && d.connection.asn ? 'AS' + d.connection.asn : '', org: d.connection && d.connection.org, city: d.city, region: d.region, country: d.country }) },
      { url: 'https://api.ipify.org?format=json', parse: (d) => ({ ip: d.ip }) }
    ];
    for (let i = 0; i < apis.length; i++) {
      try {
        const r = await fetch(apis[i].url, { cache: 'no-store' });
        if (!r.ok) continue;
        const info = apis[i].parse(await r.json());
        if (info && info.ip) { state.ip = info; renderIp(false); return; }
      } catch (e) { /* 换下一个源 */ }
    }
    state.ip = null;
    renderIp(true);
  }

  function renderConn() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) { el('ovConn').textContent = '未知'; return; }
    const parts = [];
    if (c.effectiveType) parts.push(c.effectiveType);
    if (c.downlink) parts.push('≈' + c.downlink + ' Mbps');
    if (c.rtt) parts.push('rtt ' + c.rtt + ' ms');
    if (c.saveData) parts.push('省流量');
    el('ovConn').textContent = parts.join(' · ') || '未知';
  }

  function renderInfo() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = ''; }
    const rows = [
      ['浏览器', navigator.userAgent],
      ['语言', navigator.language],
      ['时区', tz],
      ['屏幕', screen.width + '×' + screen.height + ' @' + (window.devicePixelRatio || 1) + 'x'],
      ['逻辑核心', navigator.hardwareConcurrency],
      ['设备内存', navigator.deviceMemory ? navigator.deviceMemory + ' GB' : ''],
      ['页面协议', location.protocol.replace(':', '')],
      ['连接类型', c.effectiveType],
      ['下行估计', c.downlink ? c.downlink + ' Mbps' : ''],
      ['RTT 估计', c.rtt ? c.rtt + ' ms' : ''],
      ['省流量模式', c.saveData ? '开启' : '关闭']
    ];
    el('infoGrid').innerHTML = rows.map((r) =>
      '<div><span>' + esc(r[0]) + '</span><span>' + esc(r[1] || '未知') + '</span></div>').join('');
  }

  async function runDiag() {
    const out = el('diagOut');
    out.hidden = false;
    out.textContent = '诊断中…';
    const base = 'https://speed.cloudflare.com/__down?bytes=1';
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const url = base + '&_=' + Math.random().toString(36).slice(2);
      let from = 0;
      try { from = performance.getEntriesByType('resource').length; } catch (e) { from = 0; }
      const t0 = performance.now();
      try {
        await fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
        runs.push({ ms: performance.now() - t0, timing: findTiming(url, from) });
      } catch (e) {
        runs.push({ err: describeError(e, 'https') });
      }
    }
    const tm = (runs[1] && runs[1].timing) || (runs[0] && runs[0].timing);
    const L = [];
    L.push('目标            : speed.cloudflare.com');
    L.push('冷连接 RTT      : ' + (runs[0] ? (runs[0].ms != null ? fmtMs(runs[0].ms) : runs[0].err) : '--'));
    L.push('热连接 RTT      : ' + (runs[1] ? (runs[1].ms != null ? fmtMs(runs[1].ms) : runs[1].err) : '--'));
    if (tm && tm.full) {
      L.push('DNS 解析        : ' + fmtMs(tm.dns));
      L.push('TCP 握手        : ' + fmtMs(tm.tcp));
      L.push('TLS 握手        : ' + fmtMs(tm.tls));
      L.push('TTFB            : ' + fmtMs(tm.ttfb));
      L.push('HTTP 协议       : ' + (tm.proto || '未知') + (tm.proto === 'h3' ? '（HTTP/3 / QUIC）' : ''));
    } else {
      L.push('分段耗时        : 目标未返回 Timing-Allow-Origin，浏览器按安全策略不暴露 DNS/TCP/TLS 分段');
      if (tm && tm.proto) L.push('HTTP 协议       : ' + tm.proto);
    }
    const c = navigator.connection || {};
    L.push('浏览器估计下行  : ' + (c.downlink ? c.downlink + ' Mbps' : '未知') + '（' + (c.effectiveType || '未知') + '）');
    out.textContent = L.join('\n');
    state.lastDiag = out.textContent;
  }

  /* ---------------- 报告 / 历史 ---------------- */
  function buildReport() {
    const L = [];
    L.push('=== 网络测速报告 ===');
    L.push('时间     : ' + new Date().toLocaleString());
    if (state.ip) {
      L.push('IP       : ' + state.ip.ip + ' | ' + [state.ip.asn, state.ip.org].filter(Boolean).join(' ') +
        ' | ' + [state.ip.country, state.ip.region, state.ip.city].filter(Boolean).join(' / '));
    }
    const done = state.lat.done || [];
    if (done.length) {
      const sorted = done.slice().sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        return a.ok ? a.avg - b.avg : 0;
      });
      L.push('');
      L.push('--- 延迟（ms：最小 / 平均 / 最大 / 抖动） ---');
      sorted.forEach((r) => {
        L.push(r.ok
          ? r.target + '\t' + r.min.toFixed(1) + '\t' + r.avg.toFixed(1) + '\t' + r.max.toFixed(1) +
            '\t' + r.jitter.toFixed(1) + '\t成功率 ' + r.rate + '%'
          : r.target + '\t失败（' + r.error + '）');
      });
    }
    if (state.lastResult.dl) { L.push(''); L.push('--- 下载 ---'); L.push(state.lastResult.dl); }
    if (state.lastResult.up) { L.push(''); L.push('--- 上传 ---'); L.push(state.lastResult.up); }
    if (state.lastDiag) { L.push(''); L.push('--- 诊断 ---'); L.push(state.lastDiag); }
    return L.join('\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }
  function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function pushHistory(entry) {
    entry.time = new Date().toLocaleString();
    state.history.unshift(entry);
    if (state.history.length > 10) state.history.length = 10;
    store.set('sdise-speed-history', state.history);
    renderHistory();
  }
  function renderHistory() {
    const tb = el('histTable').querySelector('tbody');
    if (!state.history.length) {
      tb.innerHTML = '<tr><td colspan="4" class="empty">暂无记录</td></tr>';
      return;
    }
    tb.innerHTML = state.history.map((h) =>
      '<tr><td>' + esc(h.time) + '</td><td>' + esc(h.type) + '</td><td>' + esc(h.summary) +
      '</td><td class="detail">' + esc(h.detail || '') + '</td></tr>').join('');
  }

  /* ---------------- 主题 / 单位 ---------------- */
  function applyTheme(t) {
    state.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    store.set('sdise-speed-theme', t);
    el('themeToggle').textContent = t === 'dark' ? '☀️' : '🌙';
    buildChart();
  }
  function setUnit(u) {
    state.unit = u;
    $$('input[name="unit"]').forEach((r) => { r.checked = r.value === u; });
    $$('input[name="unit2"]').forEach((r) => { r.checked = r.value === u; });
    if (snapshots.dl) paint('dl', snapshots.dl);
    if (snapshots.up) paint('up', snapshots.up);
    buildChart();
  }

  /* ---------------- 初始化 ---------------- */
  function bind() {
    // 主题
    el('themeToggle').addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
    el('btnRefreshIp').addEventListener('click', () => { fetchIp(); renderConn(); });

    // 预设
    $$('.chip').forEach((c) => c.addEventListener('click', () => {
      const k = c.getAttribute('data-preset');
      el('latTargets').value = k === 'clear' ? '' : (PRESETS[k] || []).join('\n');
    }));

    // 延迟
    el('btnLatStart').addEventListener('click', runLatency);
    el('btnLatStop').addEventListener('click', () => { state.lat.abort = true; });
    el('btnLatCopy').addEventListener('click', async () => {
      if (!state.lat.done.length) { setStatus('latStatus', '还没有结果可复制', 'warn'); return; }
      const ok = await copyText(buildReport());
      setStatus('latStatus', ok ? '已复制到剪贴板' : '复制失败，请手动选择', ok ? 'ok' : 'warn');
    });
    el('btnLatCsv').addEventListener('click', () => {
      if (!state.lat.done.length) { setStatus('latStatus', '还没有结果可导出', 'warn'); return; }
      const rows = [['目标', '最小(ms)', '平均(ms)', '最大(ms)', '抖动(ms)', '成功率(%)', '状态', '链路细节']];
      state.lat.done.slice().sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        return a.ok ? a.avg - b.avg : 0;
      }).forEach((r) => {
        rows.push(r.ok
          ? [r.target, r.min.toFixed(1), r.avg.toFixed(1), r.max.toFixed(1), r.jitter.toFixed(1), r.rate, '通', timingText(r.timing)]
          : [r.target, '', '', '', '', '', '失败:' + r.error, '']);
      });
      const csv = '\ufeff' + rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
      downloadFile('latency-' + Date.now() + '.csv', csv, 'text/csv;charset=utf-8');
    });

    // 标签页
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
      t.classList.add('active');
      t.setAttribute('aria-selected', 'true');
      const name = t.getAttribute('data-tab');
      $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.getAttribute('data-panel') !== name));
    }));

    // 单位
    $$('input[name="unit"], input[name="unit2"]').forEach((r) => {
      r.addEventListener('change', () => setUnit(r.value));
    });

    // 带宽
    el('btnDlStart').addEventListener('click', runDownload);
    el('btnDlStop').addEventListener('click', () => { abortAll(state.dl); });
    el('btnUpStart').addEventListener('click', runUpload);
    el('btnUpStop').addEventListener('click', () => { abortAll(state.up); });

    // 诊断 / 报告 / 历史
    el('btnDiag').addEventListener('click', runDiag);
    el('btnReport').addEventListener('click', async () => {
      const ok = await copyText(buildReport());
      const out = el('diagOut');
      out.hidden = false;
      out.textContent = ok ? '报告已复制到剪贴板。\n\n' + buildReport() : buildReport();
    });
    el('btnHistClear').addEventListener('click', () => {
      state.history = [];
      store.set('sdise-speed-history', []);
      renderHistory();
    });

    window.addEventListener('resize', () => { if (!chartInst) drawFallback(); });
  }

  function init() {
    try {
      if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(2000);
    } catch (e) { /* noop */ }
    document.documentElement.setAttribute('data-theme', state.theme);
    el('themeToggle').textContent = state.theme === 'dark' ? '☀️' : '🌙';
    renderConn();
    renderInfo();
    renderHistory();
    renderLatency();
    resetReadouts('dl');
    resetReadouts('up');
    bind();
    fetchIp();
    ensureChart().then(buildChart);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
