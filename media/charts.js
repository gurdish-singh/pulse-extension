/* Pulse — tiny dependency-free SVG chart kit (shadcn-flavoured) */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDur(ms, short) {
    if (!ms || ms < 0) return short ? '0m' : '0m';
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    if (h === 0) return `${m}m`;
    if (short && m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  // ------------------------------------------------------------ tooltip
  const tip = {
    el: null,
    show(html, evt) {
      if (!this.el) this.el = document.getElementById('tooltip');
      this.el.innerHTML = html;
      this.el.classList.add('show');
      this.move(evt);
    },
    move(evt) {
      if (!this.el || !evt) return;
      const pad = 14, r = this.el.getBoundingClientRect();
      let x = evt.clientX + pad, y = evt.clientY + pad;
      if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
      this.el.style.left = Math.max(8, x) + 'px';
      this.el.style.top = Math.max(8, y) + 'px';
    },
    hide() { if (this.el) this.el.classList.remove('show'); }
  };

  function tipRows(title, rows, footer) {
    let h = title ? `<div class="tt-title">${esc(title)}</div>` : '';
    for (const r of rows) {
      if (r === '-') { h += '<div class="tt-sep"></div>'; continue; }
      h += `<div class="tt-row"><span class="l">${r.color ? `<span class="swatch" style="background:${r.color}"></span>` : ''}${esc(r.label)}</span><span class="r">${esc(r.value)}</span></div>`;
    }
    if (footer) h += `<div class="tt-sep"></div><div class="tt-row"><span class="l">${esc(footer.label)}</span><span class="r">${esc(footer.value)}</span></div>`;
    return h;
  }

  function bindTip(node, htmlFn) {
    node.addEventListener('mouseenter', e => tip.show(htmlFn(), e));
    node.addEventListener('mousemove', e => tip.move(e));
    node.addEventListener('mouseleave', () => tip.hide());
  }

  function svgEl(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  /** Pick a "nice" duration step (in ms) so that max fits in ~4 gridlines. */
  function niceDurationTicks(maxMs) {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 7200].map(m => m * 60000);
    let step = steps[steps.length - 1];
    for (const s of steps) { if (maxMs / s <= 4) { step = s; break; } }
    const top = Math.max(step, Math.ceil(maxMs / step) * step);
    const ticks = [];
    for (let v = 0; v <= top + 1; v += step) ticks.push(v);
    return { top, ticks };
  }

  /** Rounded-top bar path (radius applies only to the top corners — data-end, anchored to baseline). */
  function topRoundedRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h));
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // ------------------------------------------------------------ stacked / simple column chart
  /**
   * opts: { labels: string[], series: [{key,name,color,values:number[]}], height, xLabel(i)->string|null,
   *         title(i)->string, onClick(i) }
   */
  function columns(el, opts) {
    el.innerHTML = '';
    el.classList.add('chart', 'dim-others');
    const width = Math.max(240, el.clientWidth || 600);
    const height = opts.height || 240;
    const m = { top: 8, right: 4, bottom: 24, left: 44 };
    const n = opts.labels.length;
    const totals = opts.labels.map((_, i) => opts.series.reduce((s, se) => s + (se.values[i] || 0), 0));
    const max = Math.max(...totals, 0);
    const { top, ticks } = niceDurationTicks(max || 3600000);
    const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': opts.ariaLabel || 'Column chart' }, el);
    const y = v => m.top + ih - (v / top) * ih;

    for (const t of ticks) {
      svgEl('line', { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? 'axis-line' : 'grid-line' }, svg);
      const lbl = svgEl('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg);
      lbl.textContent = fmtDur(t, true);
    }

    const band = iw / Math.max(1, n);
    const gapRatio = n > 60 ? 0.15 : n > 20 ? 0.25 : 0.35;
    const bw = Math.max(2, Math.min(48, band * (1 - gapRatio)));
    const labelEvery = Math.max(1, Math.ceil(n / Math.floor(iw / 46)));

    for (let i = 0; i < n; i++) {
      const g = svgEl('g', { class: 'bar-group' }, svg);
      const x0 = m.left + band * i;
      svgEl('rect', { class: 'hover-band', x: x0, y: m.top, width: band, height: ih, rx: 4 }, g);
      const x = x0 + (band - bw) / 2;
      // Stack from the bottom. 2px surface gap between segments; only the topmost gets rounded ends.
      let acc = 0;
      const segs = opts.series.map(se => ({ se, v: se.values[i] || 0 })).filter(s => s.v > 0);
      segs.forEach((s, k) => {
        const y1 = y(acc), y2 = y(acc + s.v);
        acc += s.v;
        let h = y1 - y2;
        if (k > 0) h -= 2; // surface gap
        if (h <= 0.5) return;
        const isTop = k === segs.length - 1;
        if (isTop) svgEl('path', { class: 'mark', d: topRoundedRect(x, y2, bw, h, 4), style: `fill:${s.se.color}` }, g);
        else svgEl('rect', { class: 'mark', x, y: y2, width: bw, height: h, style: `fill:${s.se.color}` }, g);
      });
      if (opts.xLabel && i % labelEvery === 0) {
        const t = opts.xLabel(i);
        if (t) {
          const txt = svgEl('text', { x: x0 + band / 2, y: height - 6, 'text-anchor': 'middle' }, svg);
          txt.textContent = t;
        }
      }
      const hit = svgEl('rect', { class: 'hit', x: x0, y: m.top, width: band, height: ih + m.bottom }, g);
      bindTip(hit, () => {
        const rows = opts.series
          .filter(se => (se.values[i] || 0) > 0)
          .sort((a, b) => b.values[i] - a.values[i])
          .map(se => ({ label: se.name, value: fmtDur(se.values[i]), color: se.color }));
        if (!rows.length) rows.push({ label: 'No activity', value: '—' });
        return tipRows(opts.title ? opts.title(i) : opts.labels[i], rows,
          opts.series.length > 1 ? { label: 'Total', value: fmtDur(totals[i]) } : null);
      });
      if (opts.onClick) { hit.style.cursor = 'pointer'; hit.addEventListener('click', () => opts.onClick(i)); }
    }
  }

  // ------------------------------------------------------------ donut
  /** opts: { items: [{name,value,color}], centerValue, centerLabel, size } */
  function donut(el, opts) {
    el.innerHTML = '';
    el.classList.add('chart');
    const size = opts.size || 200;
    const r = size / 2, inner = r * 0.66;
    const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, height: size, role: 'img', 'aria-label': opts.ariaLabel || 'Donut chart' }, el);
    const total = opts.items.reduce((s, it) => s + it.value, 0);
    if (!total) {
      svgEl('circle', { cx: r, cy: r, r: (r + inner) / 2, fill: 'none', style: 'stroke:var(--muted)', 'stroke-width': r - inner }, svg);
    } else {
      let a = -Math.PI / 2;
      const single = opts.items.filter(i => i.value > 0).length === 1;
      for (const it of opts.items) {
        if (!it.value) continue;
        const sweep = (it.value / total) * Math.PI * 2;
        const a2 = a + sweep;
        if (single || sweep >= Math.PI * 2 - 1e-6) {
          const ring = svgEl('circle', { cx: r, cy: r, r: (r + inner) / 2, class: 'arc', fill: 'none', style: `stroke:${it.color};stroke-width:${r - inner}` }, svg);
          bindTip(ring, () => tipRows(null, [{ label: it.name, value: `${fmtDur(it.value)} · 100%`, color: it.color }]));
          a = a2;
          continue;
        }
        const large = sweep > Math.PI ? 1 : 0;
        const p = (ang, rad) => `${r + rad * Math.cos(ang)},${r + rad * Math.sin(ang)}`;
        const d = `M${p(a, r)}A${r},${r} 0 ${large} 1 ${p(a2, r)}L${p(a2, inner)}A${inner},${inner} 0 ${large} 0 ${p(a, inner)}Z`;
        const path = svgEl('path', { d, class: 'arc', 'fill-rule': 'evenodd', style: `fill:${it.color};stroke:var(--card);stroke-width:2;stroke-linejoin:round` }, svg);
        bindTip(path, () => tipRows(null, [{ label: it.name, value: `${fmtDur(it.value)} · ${Math.round((it.value / total) * 100)}%`, color: it.color }]));
        a = a2;
      }
    }
    const v = svgEl('text', { x: r, y: r + 2, 'text-anchor': 'middle', class: 'donut-center-value' }, svg);
    v.textContent = opts.centerValue || '';
    const l = svgEl('text', { x: r, y: r + 20, 'text-anchor': 'middle', class: 'donut-center-label' }, svg);
    l.textContent = opts.centerLabel || '';
  }

  // ------------------------------------------------------------ sequential level helper
  function level(v, max) {
    if (!v || !max) return 0;
    const t = v / max;
    return t > 0.8 ? 5 : t > 0.6 ? 4 : t > 0.4 ? 3 : t > 0.2 ? 2 : 1;
  }

  // ------------------------------------------------------------ weekday × hour heatmap
  /** opts: { values: number[7][24], rowLabels: string[] } */
  function heatmap(el, opts) {
    el.innerHTML = '';
    el.classList.add('chart');
    const width = Math.max(320, el.clientWidth || 600);
    const m = { top: 4, left: 38, right: 0, bottom: 20 };
    const cols = 24, rows = opts.values.length;
    const gap = 3;
    const cw = (width - m.left - m.right - gap * (cols - 1)) / cols;
    const ch = Math.min(26, Math.max(14, cw * 0.8));
    const height = m.top + rows * ch + (rows - 1) * gap + m.bottom;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Activity by weekday and hour' }, el);
    const max = Math.max(...opts.values.flat(), 0);
    for (let r = 0; r < rows; r++) {
      const t = svgEl('text', { x: 0, y: m.top + r * (ch + gap) + ch / 2 + 4 }, svg);
      t.textContent = opts.rowLabels[r];
      for (let c = 0; c < cols; c++) {
        const v = opts.values[r][c];
        const rect = svgEl('rect', {
          class: 'heat-cell', x: m.left + c * (cw + gap), y: m.top + r * (ch + gap), width: cw, height: ch, rx: 3,
          style: `fill:var(--q${level(v, max)})`
        }, svg);
        bindTip(rect, () => tipRows(`${opts.rowLabels[r]} · ${String(c).padStart(2, '0')}:00–${String((c + 1) % 24).padStart(2, '0')}:00`,
          [{ label: 'Tracked', value: fmtDur(v) }]));
      }
    }
    for (let c = 0; c < cols; c += 3) {
      const t = svgEl('text', { x: m.left + c * (cw + gap), y: height - 4 }, svg);
      t.textContent = `${String(c).padStart(2, '0')}h`;
    }
  }

  // ------------------------------------------------------------ calendar (GitHub-style)
  /** opts: { end: Date, weeks: number, valueFor(dateKey)->ms, keyFor(Date)->string, onClick(key) } */
  function calendar(el, opts) {
    el.innerHTML = '';
    el.classList.add('chart');
    const width = Math.max(320, el.clientWidth || 700);
    const weeks = opts.weeks || 53;
    const m = { top: 18, left: 30, bottom: 4 };
    const gap = 3;
    const cell = Math.min(16, (width - m.left - gap * (weeks - 1)) / weeks);
    const height = m.top + 7 * cell + 6 * gap + m.bottom;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Daily activity calendar' }, el);
    const end = new Date(opts.end); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(end.getDate() - end.getDay() - (weeks - 1) * 7);
    const vals = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) vals.push(opts.valueFor(opts.keyFor(d)));
    const max = Math.max(...vals, 0);
    ['Mon', 'Wed', 'Fri'].forEach((n, k) => {
      const t = svgEl('text', { x: 0, y: m.top + (1 + k * 2) * (cell + gap) + cell / 2 + 4 }, svg);
      t.textContent = n;
    });
    let lastMonth = -1, idx = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1), idx++) {
      const w = Math.floor(idx / 7), dow = d.getDay();
      const x = m.left + w * (cell + gap), y = m.top + dow * (cell + gap);
      if (dow === 0 && d.getMonth() !== lastMonth) {
        lastMonth = d.getMonth();
        if (w < weeks - 1) {
          const t = svgEl('text', { x, y: 11 }, svg);
          t.textContent = d.toLocaleString(undefined, { month: 'short' });
        }
      }
      const key = opts.keyFor(d), v = vals[idx];
      const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const rect = svgEl('rect', { class: 'heat-cell', x, y, width: cell, height: cell, rx: 3, style: `fill:var(--q${level(v, max)})` }, svg);
      bindTip(rect, () => tipRows(label, [{ label: 'Tracked', value: v ? fmtDur(v) : 'No activity' }]));
      if (opts.onClick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', () => opts.onClick(key)); }
    }
  }

  window.Charts = { columns, donut, heatmap, calendar, tip, tipRows, bindTip, fmtDur, esc, level };
})();
