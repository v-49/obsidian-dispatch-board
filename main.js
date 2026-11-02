const { Plugin, ItemView, PluginSettingTab, Setting, TFolder, TFile, Menu, Notice, MarkdownRenderer, normalizePath, setIcon } = require('obsidian');

const VIEW_TYPE = 'dispatch-board-view';
const STORE_PATH = '1.1-主任务/调度台.json';
const INBOX = '待分配';
const BENCH_PATH = '2-工作台.md';
const HISTORY_DIR = '1.3-已归档/work/工作台历史';
const ROLL_IDLE_MS = 10 * 60 * 1000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DEFAULT_CONFIG = {
  lanes: [
    { id: '我在推', hint: '球在我这', watch: true },
    { id: '等别人', hint: '等客户、内部或别的条件', watch: true },
    { id: '搁置', hint: '暂时不动' },
    { id: '归档', hint: '已结束', collapsed: true, archive: true },
  ],
  stages: ['起步', '梳理', '方案', '验证', '落地'],
  levels: [
    { id: '高', color: '#e5484d' },
    { id: '中', color: '#e8a33d' },
    { id: '低', color: '' },
  ],
  columns: [
    { key: 'level', label: '重要', kind: 'level', show: true },
    { key: 'name', label: '项目', kind: 'name', show: true },
    { key: 'line', label: 'Type', kind: 'line', show: true },
    { key: 'stage', label: '阶段', kind: 'stage', show: true },
    { key: 'node', label: '现在到哪', kind: 'text', show: true },
    { key: 'next', label: '下一步', kind: 'text', show: true },
    { key: '等谁', label: '等谁', kind: 'text', width: 96, show: false, custom: true },
    { key: '下次跟进', label: '下次跟进', kind: 'date', show: false, custom: true },
    { key: 'days', label: '没动', kind: 'days', show: true },
  ],
  staleDays: 14,
  fadeDays: 30,
  freshDays: 3,
  sort: { key: 'level', dir: 'asc' },
};
const DEFAULT_STORE = {
  version: 1,
  roots: [
    { path: '1.1-主任务/work', line: '工作' },
    { path: '1.1-主任务/personal', line: '个人' },
  ],
  archive: ['1.1-主任务/work/归档'],
  ignore: ['1.1-主任务/work/会议纪要'],
  projects: {},
};
const DEFAULT_WIDTH = { level: 16, name: 148, line: 32, stage: 92, days: 48, date: 84, select: 110 };
const FIXED_NOTE = {
  level: '插件内置：点行首圆点切换',
  name: '插件内置：每个文件夹就是一行，右键行可重命名文件夹',
  line: '插件内置：看项目在哪个根目录，work 是 W，personal 是 P',
  stage: '插件内置：点小圆点设置阶段',
  days: '插件内置：自动取文件夹里最新的修改时间',
};
const CUSTOM_KINDS = { text: '文字', select: '选项', date: '日期' };
const CHIP_TONES = 6;

const clone = (x) => JSON.parse(JSON.stringify(x));
const pad = (n) => String(n).padStart(2, '0');
const toDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => toDay(new Date());
const hashTone = (s) => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % CHIP_TONES;

function daysSince(ts) {
  if (!ts) return null;
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(ts); b.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((a - b) / 86400000));
}

function daysUntil(day) {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  return Math.round((new Date(day + 'T00:00:00') - a) / 86400000);
}

// "11.2" has no year: assume this year unless that lands far in the future.
function resolveDay(month, date) {
  const now = new Date();
  let year = now.getFullYear();
  if (new Date(year, month - 1, date) - now > 60 * 86400000) year -= 1;
  return `${year}-${pad(month)}-${pad(date)}`;
}

function headingDay(line, prevBlank) {
  const iso = line.match(/^#{0,3}\s*(20\d\d-\d\d-\d\d)\s*$/);
  if (iso) return iso[1];
  const short = prevBlank && line.match(/^(\d{1,2})\.(\d{1,2})\s*$/);
  if (!short) return null;
  const m = Number(short[1]), d = Number(short[2]);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? resolveDay(m, d) : null;
}

// Split text into dated blocks; raw blocks concatenate back to exactly the original text.
function splitDays(text, fallbackDay, matcher) {
  const blocks = [];
  let cur = { day: null, head: null, lines: [] };
  let fenced = false;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.startsWith('```')) fenced = !fenced;
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const day = fenced ? null : matcher(line, prevBlank);
    if (day) {
      if (cur.head !== null || cur.lines.length) blocks.push(cur);
      cur = { day, head: line, lines: [] };
    } else cur.lines.push(line);
  });
  blocks.push(cur);
  return blocks.map((b, i) => {
    const rawLines = (b.head !== null ? [b.head] : []).concat(b.lines);
    const raw = rawLines.join('\n') + (i < blocks.length - 1 ? '\n' : '');
    return { day: b.day || fallbackDay, hasHead: b.head !== null, raw, body: b.lines.join('\n').trim() };
  }).filter((b) => b.raw.length);
}

function collectFiles(folder, out = []) {
  for (const c of folder.children) {
    if (c instanceof TFile) out.push(c);
    else if (c instanceof TFolder) collectFiles(c, out);
  }
  return out;
}

class DispatchView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filter = '全部';
    this.expanded = new Set();
    this.hovered = null;
    this.dirty = false;
    this.suppressClick = false;
    this.addingIn = null;
    this.renaming = null;
    this.popClose = null;
    this.page = 'board';
    this.histQuery = '';
    this.histOpen = new Set();
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '调度台'; }
  getIcon() { return 'layout-list'; }

  async onOpen() {
    this.contentEl.addClass('db-root');
    this.registerDomEvent(document, 'keydown', (e) => this.onKey(e));
    this.render();
  }

  async onClose() { this.closePop(); }

  onKey(e) {
    if (this.app.workspace.getActiveViewOfType(DispatchView) !== this || !this.hovered) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    const lane = this.plugin.cfg.lanes[Number(e.key) - 1];
    if (lane) { e.preventDefault(); this.plugin.setLane(this.hovered, lane.id); }
  }

  requestRender() {
    if (document.body.hasClass('db-is-dragging') || this.contentEl.querySelector('input:focus, select:focus')) { this.dirty = true; return; }
    this.render();
  }

  isCollapsed(lane) {
    return !!lane.collapsed;
  }

  visibleColumns() {
    return this.plugin.cfg.columns.filter((c) => c.show || c.kind === 'name');
  }

  track(c) {
    const w = c.width || DEFAULT_WIDTH[c.kind];
    return w ? `${w}px` : 'minmax(0, 1fr)';
  }

  tracks(cols) { return [...cols.map((c) => this.track(c)), '26px'].join(' '); }

  minWidth(cols) {
    const sum = cols.reduce((a, c) => a + (c.width || DEFAULT_WIDTH[c.kind] || 150) + 8, 34);
    return sum + 8;
  }

  render() {
    const root = this.contentEl;
    const scroller = root.querySelector('.db-list');
    const top = scroller ? scroller.scrollTop : 0;
    const left = scroller ? scroller.scrollLeft : 0;
    root.empty();
    this.dirty = false;
    const cfg = this.plugin.cfg;
    const lines = this.plugin.store.roots.map((r) => r.line);
    if (this.filter !== '全部' && !lines.includes(this.filter)) this.filter = '全部';
    const shown = this.plugin.projects().filter((p) => this.filter === '全部' || p.line === this.filter);
    this.renderHead(root, shown, lines);
    if (this.page === 'history') { this.renderHistory(root); return; }
    const cols = this.visibleColumns();
    const tracks = this.tracks(cols);
    const list = root.createDiv('db-list');
    const table = list.createDiv('db-table');
    table.style.minWidth = this.minWidth(cols) + 'px';
    this.renderFocus(table, shown);
    this.renderColumnHead(table, cols, tracks);
    for (const lane of [{ id: INBOX, hint: '新发现的文件夹，拖到下面归位', system: true }, ...cfg.lanes]) {
      const items = shown.filter((p) => p.lane === lane.id).sort((a, b) => this.plugin.compareRows(a, b));
      if (lane.system && !items.length) continue;
      this.renderLane(table, lane, items, cols, tracks, lines);
    }
    const addLane = table.createDiv({ cls: 'db-add-lane', text: '＋ 新建分组' });
    addLane.onclick = () => {
      const id = this.plugin.addLaneAuto();
      this.render();
      this.openLaneMenu(id);
    };
    list.scrollTop = top;
    list.scrollLeft = left;
  }

  renderHead(root, shown, lines) {
    const head = root.createDiv('db-head');
    const pages = head.createDiv('db-pages');
    for (const [id, name] of [['board', '调度'], ['history', '历史']]) {
      const b = pages.createDiv({ cls: 'db-page' + (this.page === id ? ' is-on' : ''), text: name });
      b.onclick = () => { this.page = id; this.closePop(); this.render(); };
    }
    if (this.page === 'board') {
      const tabs = head.createDiv('db-tabs');
      for (const t of ['全部', ...lines]) {
        const b = tabs.createDiv({ cls: 'db-tab' + (this.filter === t ? ' is-on' : ''), text: t });
        b.onclick = () => { this.filter = t; this.render(); };
      }
    }
    const gear = head.createDiv({ cls: 'db-iconbtn', attr: { 'aria-label': '扫描范围和提醒' } });
    setIcon(gear, 'settings');
    gear.onclick = () => this.plugin.openSettings();
  }

  // What today's notes touch, and what matters but was not written down today.
  renderFocus(table, shown) {
    const cfg = this.plugin.cfg;
    const top = cfg.levels[0] && cfg.levels[0].id;
    const watched = cfg.lanes.filter((l) => l.watch).map((l) => l.id);
    const live = shown.filter((p) => p.lane !== INBOX && !cfg.lanes.some((l) => l.id === p.lane && l.archive));
    const today_ = live.filter((p) => p.mentions.length);
    const dateCols = cfg.columns.filter((c) => c.kind === 'date');
    const isDue = (p) => dateCols.some((c) => p.fields[c.key] && daysUntil(p.fields[c.key]) <= 0);
    const forgot = live.filter((p) => !p.mentions.length && watched.includes(p.lane) && (p.level === top || isDue(p)));
    if (!today_.length && !forgot.length) return;
    const box = table.createDiv('db-focus');
    const group = (label, items, cls) => {
      if (!items.length) return;
      const row = box.createDiv('db-focus-row');
      row.createSpan({ cls: 'db-focus-label', text: label });
      for (const p of items) {
        const chip = row.createSpan({ cls: 'db-focus-chip ' + cls, text: p.name, attr: { 'data-key': p.key } });
        chip.onclick = () => this.jumpTo(p);
      }
    };
    group('今天写到', today_, 'is-today');
    group('别忘了', forgot, 'is-forgot');
  }

  jumpTo(p) {
    const lane = this.plugin.cfg.lanes.find((l) => l.id === p.lane);
    if (lane && lane.collapsed) { lane.collapsed = false; this.plugin.save(); }
    this.expanded.add(p.key);
    this.render();
    const row = [...this.contentEl.querySelectorAll('.db-row')].find((r) => r.getAttribute('data-key') === p.key);
    if (row) row.scrollIntoView({ block: 'center' });
  }

  // ---------- history ----------
  async renderHistory(root) {
    const wrap = root.createDiv('db-history');
    const input = wrap.createEl('input', { cls: 'db-hist-search', type: 'text', placeholder: '搜索历史记录', value: this.histQuery });
    const countEl = wrap.createDiv('db-hist-count');
    const list = wrap.createDiv('db-hist-list');
    const { entries, others } = await this.plugin.readHistory();
    if (!wrap.isConnected) return;
    const draw = () => {
      list.empty();
      const q = this.histQuery.trim();
      const hits = q ? entries.filter((e) => e.body.includes(q)) : entries;
      countEl.setText(q ? `找到 ${hits.length} 天` : `共 ${entries.length} 天`);
      let month = '';
      hits.forEach((e) => {
        const m = e.day.slice(0, 7);
        if (m !== month) { month = m; list.createDiv({ cls: 'db-hist-month', text: m }); }
        const id = `${e.path}#${e.day}#${e.seq}`;
        const row = list.createDiv('db-hist-row');
        const line = row.createDiv('db-hist-line');
        const d = new Date(e.day + 'T12:00:00');
        line.createSpan({ cls: 'db-hist-date', text: `${e.day.slice(5)} ${WEEKDAYS[d.getDay()]}` });
        line.createSpan({ cls: 'db-hist-preview', text: e.preview });
        const body = row.createDiv('db-hist-body');
        const fill = () => {
          body.empty();
          const orig = body.createEl('a', { cls: 'db-hist-open', text: '打开原文' });
          orig.onclick = () => this.app.workspace.openLinkText(`${e.path}#${e.day}`, '', true);
          const md = body.createDiv('markdown-rendered');
          MarkdownRenderer.render(this.app, e.body, md, e.path, this);
        };
        if (this.histOpen.has(id)) fill(); else body.hide();
        line.onclick = () => {
          if (this.histOpen.has(id)) { this.histOpen.delete(id); body.hide(); } else { this.histOpen.add(id); fill(); body.show(); }
        };
      });
      if (!hits.length) list.createDiv({ cls: 'db-empty', text: q ? '没有找到' : '还没有历史记录，翻篇之后会出现在这里' });
      if (others.length && !q) {
        list.createDiv({ cls: 'db-hist-month', text: '更早的整理记录' });
        for (const f of others) {
          const a = list.createDiv('db-hist-row').createEl('a', { cls: 'db-hist-other', text: f.basename });
          a.onclick = () => this.app.workspace.getLeaf(true).openFile(f);
        }
      }
    };
    input.oninput = () => { this.histQuery = input.value; draw(); };
    draw();
  }

  // ---------- popover ----------
  closePop() {
    if (this.popClose) { const f = this.popClose; this.popClose = null; f(); }
  }

  openPop(anchor, build, width = 250) {
    this.closePop();
    const pop = document.body.createDiv('db-pop');
    pop.style.width = width + 'px';
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const h = pop.offsetHeight;
      pop.style.left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8)) + 'px';
      const below = a.bottom + 4;
      pop.style.top = (below + h > window.innerHeight - 8 ? Math.max(8, window.innerHeight - h - 8) : below) + 'px';
    };
    const close = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc, true);
      pop.remove();
    };
    const outside = (e) => { if (!pop.contains(e.target) && !(e.target.closest && e.target.closest('.menu'))) this.closePop(); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.closePop(); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
    this.popClose = close;
    const rebuild = () => { pop.empty(); build(pop, rebuild); place(); };
    rebuild();
    return pop;
  }

  popItem(pop, { icon, text, onClick, danger, checked }) {
    const it = pop.createDiv({ cls: 'db-pop-item' + (danger ? ' is-danger' : '') });
    const ic = it.createSpan('db-pop-icon');
    if (icon) setIcon(ic, icon);
    it.createSpan({ text });
    if (checked) setIcon(it.createSpan('db-pop-check'), 'check');
    it.onclick = onClick;
    return it;
  }

  popInput(pop, value, placeholder, commit, opts = {}) {
    const input = pop.createEl('input', { cls: 'db-pop-input', type: 'text', value, placeholder });
    let used = false;
    const done = () => {
      const v = input.value.trim();
      if (used || !v || v === value) return;
      used = true;
      commit(v);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { done(); if (opts.closeOnEnter) this.closePop(); else input.blur(); }
    };
    if (!opts.noBlur) input.onblur = done;
    return input;
  }

  // Editable option list used for stages, levels and select columns.
  optionEditor(pop, rebuild, title, list, { name, rename, remove, add, color, minCount = 0 }) {
    pop.createDiv({ cls: 'db-pop-label', text: title });
    list.forEach((item, i) => {
      const row = pop.createDiv('db-opt');
      const input = row.createEl('input', { type: 'text', value: name(item) });
      const original = name(item);
      let used = false;
      const commit = () => {
        if (used) return;
        const v = input.value.trim();
        if (!v || v === original) { input.value = original; return; }
        if (rename(item, v) === false) { input.value = original; return; }
        used = true;
        rebuild();
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') commit(); };
      input.onblur = commit;
      if (color) {
        const c = row.createEl('input', { type: 'color', value: item.color || '#999999', attr: { 'aria-label': '颜色' } });
        c.onchange = () => { item.color = c.value; this.plugin.saveConfig(); };
        const hollow = row.createEl('button', { cls: 'db-opt-btn', attr: { 'aria-label': '改成空心' } });
        setIcon(hollow, 'circle');
        hollow.onclick = () => { item.color = ''; this.plugin.saveConfig(); rebuild(); };
      }
      const up = row.createEl('button', { cls: 'db-opt-btn', attr: { 'aria-label': '上移' } });
      setIcon(up, 'chevron-up');
      up.disabled = i === 0;
      up.onclick = () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; this.plugin.saveConfig(); rebuild(); };
      const del = row.createEl('button', { cls: 'db-opt-btn', attr: { 'aria-label': '删除' } });
      setIcon(del, 'x');
      del.disabled = list.length <= minCount;
      del.onclick = () => { remove(item); this.plugin.saveConfig(); rebuild(); };
    });
    const adder = pop.createEl('input', { cls: 'db-pop-input db-opt-add', type: 'text', placeholder: '＋ 添加，回车' });
    adder.onkeydown = (e) => {
      if (e.key !== 'Enter' || !adder.value.trim()) return;
      if (add(adder.value.trim()) !== false) { this.plugin.saveConfig(); rebuild(); pop.querySelector('.db-opt-add').focus(); }
    };
  }

  // ---------- column header ----------
  renderColumnHead(table, cols, tracks) {
    const cfg = this.plugin.cfg;
    const row = table.createDiv('db-colhead');
    row.style.gridTemplateColumns = tracks;
    for (const c of cols) {
      const cell = row.createDiv({ cls: 'db-colhead-cell db-k-' + c.kind, attr: { 'data-col': c.key } });
      if (c.custom) cell.addClass('is-custom');
      cell.createSpan({ cls: 'db-colhead-label', text: c.kind === 'level' ? '●' : c.label });
      if (cfg.sort !== 'manual' && cfg.sort.key === c.key) {
        cell.addClass('is-sort');
        cell.createSpan({ cls: 'db-colhead-arrow', text: cfg.sort.dir === 'desc' ? '↓' : '↑' });
      }
      cell.addEventListener('pointerdown', (e) => this.startColumnDrag(e, c, cell));
      if (c.kind !== 'level') {
        const grip = cell.createDiv('db-resize');
        grip.addEventListener('pointerdown', (e) => this.startResize(e, c, cell));
      }
    }
    const plus = row.createDiv({ cls: 'db-colhead-plus', text: '＋', attr: { 'aria-label': '添加列' } });
    plus.onclick = () => this.openAddColumn(plus);
  }

  applyTracks() {
    const cols = this.visibleColumns();
    const t = this.tracks(cols);
    this.contentEl.querySelectorAll('.db-colhead, .db-row').forEach((el) => { el.style.gridTemplateColumns = t; });
    const table = this.contentEl.querySelector('.db-table');
    if (table) table.style.minWidth = this.minWidth(cols) + 'px';
  }

  startResize(e, col, cell) {
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    const start = cell.getBoundingClientRect().width;
    document.body.addClass('db-is-resizing');
    const move = (ev) => {
      col.width = Math.max(40, Math.round(start + ev.clientX - sx));
      this.applyTracks();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.removeClass('db-is-resizing');
      this.plugin.saveConfig();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  startColumnDrag(e, col, cell) {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null, over = null, after = false;
    const clear = () => {
      this.contentEl.querySelectorAll('.db-colhead-cell.is-before, .db-colhead-cell.is-after').forEach((el) => el.removeClass('is-before', 'is-after'));
    };
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!ghost) {
        ghost = document.body.createDiv({ cls: 'db-ghost', text: col.label });
        document.body.addClass('db-is-dragging');
      }
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 8 + 'px';
      clear();
      over = null;
      for (const el of this.contentEl.querySelectorAll('.db-colhead-cell')) {
        const b = el.getBoundingClientRect();
        if (ev.clientX >= b.left - 4 && ev.clientX <= b.right + 4) {
          over = el.getAttribute('data-col');
          after = ev.clientX > b.left + b.width / 2;
          if (over !== col.key) el.addClass(after ? 'is-after' : 'is-before');
          break;
        }
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!ghost) { this.openColumnMenu(col.key); return; }
      ghost.remove();
      document.body.removeClass('db-is-dragging');
      clear();
      if (over && over !== col.key) this.plugin.moveColumn(col.key, over, after);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  headerCell(key) {
    return [...this.contentEl.querySelectorAll('.db-colhead-cell')].find((c) => c.getAttribute('data-col') === key);
  }

  openColumnMenu(key, focusName = false) {
    const anchor = this.headerCell(key);
    if (!anchor) return;
    const p = this.plugin;
    let liveKey = key;
    const pop = this.openPop(anchor, (el, rebuild) => {
      const col = p.cfg.columns.find((c) => c.key === liveKey);
      if (!col) { this.closePop(); return; }
      this.popInput(el, col.label, '列名', (v) => {
        if (p.renameColumn(col, v) !== false) { liveKey = col.key; p.saveConfig(); rebuild(); }
      });
      if (FIXED_NOTE[col.kind]) el.createDiv({ cls: 'db-pop-note', text: FIXED_NOTE[col.kind] });
      if (col.key === 'node' || col.key === 'next') el.createDiv({ cls: 'db-pop-note', text: '内置文字列，AI 也会更新它' });
      if (col.custom) {
        el.createDiv({ cls: 'db-pop-label', text: '类型' });
        const seg = el.createDiv('db-seg');
        for (const [k, name] of Object.entries(CUSTOM_KINDS)) {
          const b = seg.createEl('button', { cls: k === col.kind ? 'is-on' : '', text: name });
          b.onclick = () => {
            col.kind = k;
            if (k === 'select' && !col.options) col.options = p.valuesOf(col);
            delete col.width;
            p.saveConfig();
            rebuild();
          };
        }
      }
      if (col.kind === 'select') {
        col.options = col.options || [];
        this.optionEditor(el, rebuild, '选项', col.options, {
          name: (x) => x,
          rename: (x, v) => p.renameOption(col, x, v),
          remove: (x) => p.removeOption(col, x),
          add: (v) => p.addOption(col, v),
        });
      }
      if (col.kind === 'stage') {
        this.optionEditor(el, rebuild, '阶段（从前到后）', p.cfg.stages, {
          name: (x) => x, minCount: 1,
          rename: (x, v) => p.renameStage(x, v),
          remove: (x) => p.removeStage(x),
          add: (v) => p.addStage(v),
        });
      }
      if (col.kind === 'level') {
        this.optionEditor(el, rebuild, '级别（最上面最重要）', p.cfg.levels, {
          name: (x) => x.id, color: true, minCount: 1,
          rename: (x, v) => p.renameLevel(x, v),
          remove: (x) => p.removeLevel(x),
          add: (v) => p.addLevel(v),
        });
      }
      el.createDiv('db-pop-sep');
      const sort = p.cfg.sort;
      const isSort = (dir) => sort !== 'manual' && sort.key === col.key && sort.dir === dir;
      this.popItem(el, { icon: 'arrow-up', text: '升序', checked: isSort('asc'), onClick: () => { p.cfg.sort = { key: col.key, dir: 'asc' }; p.saveConfig(); this.closePop(); } });
      this.popItem(el, { icon: 'arrow-down', text: '降序', checked: isSort('desc'), onClick: () => { p.cfg.sort = { key: col.key, dir: 'desc' }; p.saveConfig(); this.closePop(); } });
      el.createDiv('db-pop-sep');
      const insert = (offset) => {
        const nk = p.addColumnAt(col.key, offset);
        this.closePop();
        this.render();
        this.openColumnMenu(nk, true);
      };
      this.popItem(el, { icon: 'arrow-left-to-line', text: '在左侧插入列', onClick: () => insert(0) });
      this.popItem(el, { icon: 'arrow-right-to-line', text: '在右侧插入列', onClick: () => insert(1) });
      if (col.width) this.popItem(el, { icon: 'unfold-horizontal', text: '恢复默认宽度', onClick: () => { delete col.width; p.saveConfig(); this.closePop(); } });
      if (col.kind !== 'name') this.popItem(el, { icon: 'eye-off', text: '隐藏', onClick: () => { col.show = false; p.saveConfig(); this.closePop(); } });
      if (col.custom) {
        this.popItem(el, { icon: 'trash-2', text: '删除列（数据保留，同名加回恢复）', danger: true, onClick: () => { p.removeColumn(col); p.saveConfig(); this.closePop(); } });
      }
    });
    if (focusName) { const i = pop.querySelector('.db-pop-input'); i.focus(); i.select(); }
  }

  openAddColumn(anchor) {
    const p = this.plugin;
    const pop = this.openPop(anchor, (el, rebuild) => {
      el.createDiv({ cls: 'db-pop-label', text: '新建列' });
      const input = el.createEl('input', { cls: 'db-pop-input', type: 'text', placeholder: '列名，回车创建' });
      let kind = 'text';
      const seg = el.createDiv('db-seg');
      const btns = {};
      for (const [k, name] of Object.entries(CUSTOM_KINDS)) {
        btns[k] = seg.createEl('button', { cls: k === kind ? 'is-on' : '', text: name });
        btns[k].onclick = () => {
          kind = k;
          for (const b of Object.values(btns)) b.removeClass('is-on');
          btns[k].addClass('is-on');
          input.focus();
        };
      }
      input.onkeydown = (e) => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        if (p.addColumn(input.value.trim(), kind) !== false) { p.saveConfig(); this.closePop(); }
      };
      const hidden = p.cfg.columns.filter((c) => !c.show && c.kind !== 'name');
      if (hidden.length) {
        el.createDiv({ cls: 'db-pop-label', text: '已隐藏，点一下显示' });
        for (const c of hidden) {
          this.popItem(el, { icon: 'eye', text: c.label, onClick: () => { c.show = true; p.saveConfig(); this.closePop(); } });
        }
      }
    }, 230);
    pop.querySelector('.db-pop-input').focus();
  }

  // ---------- lanes ----------
  renderLane(table, lane, items, cols, tracks, lines) {
    const box = table.createDiv({ cls: 'db-lane', attr: { 'data-lane': lane.id } });
    const closed = !lane.system && this.isCollapsed(lane);
    const h = box.createDiv('db-lane-head');
    const caret = h.createSpan({ cls: 'db-caret', text: closed ? '▸' : '▾' });
    const toneIndex = lane.system ? 0 : lane.archive ? 5 : Math.max(0, this.plugin.cfg.lanes.indexOf(lane)) % 5;
    const name = h.createSpan({ cls: `db-lane-name tone-${toneIndex}`, text: lane.id });
    h.createSpan({ cls: 'db-lane-count', text: String(items.length) });
    if (lane.hint) h.createSpan({ cls: 'db-lane-hint', text: lane.hint });
    if (!lane.system) {
      const toggle = () => { lane.collapsed = !closed; this.plugin.save(); this.render(); };
      caret.onclick = toggle;
      name.onclick = (e) => { e.stopPropagation(); this.openLaneMenu(lane.id); };
      h.onclick = (e) => { if (e.target === h) toggle(); };
      h.oncontextmenu = (e) => { e.preventDefault(); this.openLaneMenu(lane.id); };
    }
    if (closed) return;
    if (!items.length) box.createDiv({ cls: 'db-empty', text: '拖到这里' });
    for (const p of items) this.renderRow(box, p, cols, tracks);
    if (!lane.system) this.renderNewRow(box, lane, lines);
  }

  openLaneMenu(id) {
    const anchor = [...this.contentEl.querySelectorAll('.db-lane')].find((l) => l.getAttribute('data-lane') === id);
    if (!anchor) return;
    const p = this.plugin;
    let liveId = id;
    const pop = this.openPop(anchor.querySelector('.db-lane-name'), (el, rebuild) => {
      const lane = p.cfg.lanes.find((l) => l.id === liveId);
      if (!lane) { this.closePop(); return; }
      this.popInput(el, lane.id, '分组名', (v) => {
        if (p.renameLane(lane, v) !== false) { liveId = v; p.saveConfig(); rebuild(); }
      });
      const hint = el.createEl('input', { cls: 'db-pop-input', type: 'text', value: lane.hint || '', placeholder: '说明（可不写）' });
      const saveHint = () => { if (hint.value.trim() !== (lane.hint || '')) { lane.hint = hint.value.trim(); p.saveConfig(); } };
      hint.onblur = saveHint;
      hint.onkeydown = (e) => { if (e.key === 'Enter') hint.blur(); };
      el.createDiv('db-pop-sep');
      this.popItem(el, { icon: 'bell', text: '久没动标红', checked: !!lane.watch, onClick: () => { lane.watch = !lane.watch; p.saveConfig(); rebuild(); } });
      this.popItem(el, { icon: 'chevrons-up-down', text: '默认折叠', checked: !!lane.collapsed, onClick: () => { lane.collapsed = !lane.collapsed; p.saveConfig(); rebuild(); } });
      el.createDiv('db-pop-sep');
      const i = p.cfg.lanes.indexOf(lane);
      const moveBy = (d) => { const a = p.cfg.lanes; [a[i], a[i + d]] = [a[i + d], a[i]]; p.saveConfig(); this.closePop(); };
      if (i > 0) this.popItem(el, { icon: 'chevron-up', text: '上移', onClick: () => moveBy(-1) });
      if (i < p.cfg.lanes.length - 1) this.popItem(el, { icon: 'chevron-down', text: '下移', onClick: () => moveBy(1) });
      this.popItem(el, { icon: 'plus', text: '在下方新建分组', onClick: () => {
        const nid = p.addLaneAuto(i + 1);
        this.closePop();
        this.render();
        this.openLaneMenu(nid);
      } });
      if (!lane.archive) {
        this.popItem(el, { icon: 'trash-2', text: '删除分组（项目回到待分配）', danger: true, onClick: () => { p.removeLane(lane); p.saveConfig(); this.closePop(); } });
      } else {
        el.createDiv({ cls: 'db-pop-note', text: '归档分组由插件保留，归档文件夹默认进这里' });
      }
    }, 240);
    const i = pop.querySelector('.db-pop-input');
    if (i) { i.focus(); i.select(); }
  }

  renderNewRow(box, lane, lines) {
    const wrap = box.createDiv('db-newrow');
    if (this.addingIn !== lane.id) {
      wrap.setText('＋ 新建');
      wrap.onclick = () => { this.addingIn = lane.id; this.render(); };
      return;
    }
    wrap.addClass('is-open');
    const input = wrap.createEl('input', { type: 'text', placeholder: '项目名，回车建文件夹；Esc 取消' });
    let target = lines.includes(this.filter) ? this.filter : lines[0];
    if (this.filter === '全部' && lines.length > 1) {
      const sel = wrap.createEl('select');
      for (const l of lines) sel.createEl('option', { text: l, value: l });
      sel.value = target;
      sel.onchange = () => { target = sel.value; input.focus(); };
    }
    const stop = () => { this.addingIn = null; this.render(); };
    input.onkeydown = async (e) => {
      if (e.key === 'Escape') { stop(); return; }
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const v = input.value.trim();
      input.value = '';
      await this.plugin.createProject(v, target, lane.id);
    };
    input.onblur = () => {
      setTimeout(() => {
        if (wrap.contains(document.activeElement)) return;
        if (this.addingIn === lane.id) stop();
      }, 120);
    };
    input.focus();
  }

  // ---------- rows ----------
  renderRow(box, p, cols, tracks) {
    const row = box.createDiv({ cls: `db-row fade-${p.fade}` + (p.keep ? ' is-keep' : '') + (p.mentions.length ? ' is-today' : ''), attr: { 'data-key': p.key } });
    row.style.gridTemplateColumns = tracks;
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      row.addClass('is-droptext');
    });
    row.addEventListener('dragleave', () => row.removeClass('is-droptext'));
    row.addEventListener('drop', (e) => {
      const text = ((e.dataTransfer && e.dataTransfer.getData('text/plain')) || '').replace(/\s*\n\s*/g, ' ').trim();
      row.removeClass('is-droptext');
      if (!text) return;
      e.preventDefault();
      this.expanded.add(p.key);
      this.plugin.addLog(p.key, text);
      new Notice(`已记到“${p.name}”的时间线`);
    });
    row.onmouseenter = () => { this.hovered = p.key; };
    row.onmouseleave = () => { if (this.hovered === p.key) this.hovered = null; };
    row.oncontextmenu = (e) => this.openRowMenu(e, p);
    row.addEventListener('pointerdown', (e) => this.startDrag(e, p, row));
    for (const c of cols) {
      if (c.kind === 'level') this.cellLevel(row, p);
      else if (c.kind === 'name') this.cellName(row, p);
      else if (c.kind === 'line') row.createDiv({ cls: 'db-line', text: p.type, attr: { title: p.line } });
      else if (c.kind === 'stage') this.cellStage(row, p, c);
      else if (c.kind === 'days') this.cellDays(row, p);
      else if (c.kind === 'date') this.cellDate(row, p, c);
      else if (c.kind === 'select') this.cellSelect(row, p, c);
      else this.cellText(row, p, c);
    }
    const more = row.createDiv({ cls: 'db-rowend db-nodrag', attr: { 'aria-label': '更多' } });
    setIcon(more, 'more-horizontal');
    more.onclick = (e) => this.openRowMenu(e, p);
    if (this.expanded.has(p.key)) this.renderDetail(box, p);
  }

  cellLevel(row, p) {
    const def = this.plugin.cfg.levels.find((l) => l.id === p.level);
    const imp = row.createDiv({ cls: 'db-imp db-nodrag', attr: { 'aria-label': `重要程度：${p.level}（点击切换）` } });
    const dot = imp.createSpan('db-imp-dot');
    if (def && def.color) dot.style.background = def.color; else dot.addClass('is-hollow');
    imp.onclick = () => this.plugin.cycleLevel(p.key);
  }

  cellName(row, p) {
    if (this.renaming === p.key) {
      const input = row.createEl('input', { cls: 'db-name-input db-nodrag', type: 'text', value: p.name });
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        this.renaming = null;
        const v = input.value.trim();
        if (save && v && v !== p.name) await this.plugin.renameProject(p, v);
        this.render();
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
      input.onblur = () => finish(true);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return;
    }
    const name = row.createDiv({ cls: 'db-name', text: p.name, attr: { title: p.key } });
    name.onclick = () => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (this.expanded.has(p.key)) this.expanded.delete(p.key); else this.expanded.add(p.key);
      this.render();
    };
    if (p.virtual) name.addClass('is-virtual');
  }

  cellStage(row, p, col) {
    const stages = this.plugin.cfg.stages;
    const wrap = row.createDiv('db-stagecell db-nodrag');
    const dots = wrap.createDiv({ cls: 'db-dots', attr: { 'aria-label': `阶段：${p.stage || '未定'}（点击设置）` } });
    stages.forEach((s, i) => {
      const d = dots.createSpan({ cls: 'db-dot' + (stages.indexOf(p.stage) >= i ? ' is-on' : ''), attr: { 'aria-label': s } });
      d.onclick = () => this.plugin.patch(p.key, { stage: s });
    });
    wrap.createDiv({ cls: 'db-stage', text: p.stage || '—' });
  }

  cellDays(row, p) {
    const cfg = this.plugin.cfg;
    const watched = cfg.lanes.some((l) => l.id === p.lane && l.watch);
    const label = p.days === null ? '—' : p.days === 0 ? '今天' : p.days === 1 ? '昨天' : `${p.days} 天`;
    const tone = p.days === null ? '' : p.days <= cfg.freshDays ? ' is-fresh' : (watched && p.fade === 1 ? ' is-stale' : '');
    row.createDiv({ cls: 'db-days' + tone, text: label, attr: { title: p.touched ? `最近动静 ${toDay(new Date(p.touched))}` : '没有记录' } });
  }

  cellText(row, p, col) {
    const safe = /^[A-Za-z0-9_-]+$/.test(col.key) ? `db-${col.key}` : 'db-customtext';
    const cell = row.createDiv({ cls: `db-cell db-nodrag ${safe}`, attr: { 'data-col': col.key } });
    let value = this.plugin.value(p, col);
    const show = () => {
      cell.empty();
      const span = cell.createSpan({ text: value || '', attr: { title: value || '' } });
      if (!value) span.addClass('is-placeholder');
    };
    show();
    cell.onclick = () => {
      if (cell.querySelector('input')) return;
      cell.empty();
      const input = cell.createEl('input', { type: 'text', value });
      input.focus();
      input.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (save && v !== value) {
          value = v;
          show();
          this.plugin.setValue(p.key, col, v);
        } else {
          show();
          if (this.dirty) this.render();
        }
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      };
      input.onblur = () => finish(true);
    };
  }

  cellDate(row, p, col) {
    const cell = row.createDiv({ cls: 'db-cell db-nodrag db-datecell', attr: { 'data-col': col.key } });
    const value = this.plugin.value(p, col);
    const show = () => {
      cell.empty();
      if (!value) return;
      const left = daysUntil(value);
      const tone = left <= 0 ? 'is-stale' : left <= this.plugin.cfg.freshDays ? 'is-soon' : '';
      cell.createSpan({ cls: tone, text: value.slice(5), attr: { title: value } });
    };
    show();
    cell.onclick = () => {
      if (cell.querySelector('input')) return;
      cell.empty();
      const input = cell.createEl('input', { type: 'date', value });
      input.focus();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (input.value !== value) this.plugin.setValue(p.key, col, input.value);
        else { show(); if (this.dirty) this.render(); }
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') { input.value = value; finish(); } };
      input.onblur = finish;
    };
  }

  cellSelect(row, p, col) {
    const cell = row.createDiv({ cls: 'db-cell db-nodrag db-selectcell', attr: { 'data-col': col.key } });
    const value = this.plugin.value(p, col);
    if (value) cell.createSpan({ cls: `db-chip tone-${hashTone(value)}`, text: value });
    cell.onclick = () => this.openSelect(cell, p, col, value);
  }

  // Notion-style picker: type to filter, Enter creates a new option on the spot.
  openSelect(cell, p, col, value) {
    const plugin = this.plugin;
    const pop = this.openPop(cell, (el) => {
      const input = el.createEl('input', { cls: 'db-pop-input', type: 'text', placeholder: '选一个，或输入新建' });
      const listEl = el.createDiv('db-pick');
      const pick = (v) => { this.closePop(); plugin.setValue(p.key, col, v); };
      const draw = () => {
        listEl.empty();
        const q = input.value.trim();
        const opts = (col.options || []).filter((o) => !q || o.includes(q));
        for (const o of opts) {
          const it = listEl.createDiv({ cls: 'db-pop-item' });
          it.createSpan({ cls: `db-chip tone-${hashTone(o)}`, text: o });
          if (o === value) setIcon(it.createSpan('db-pop-check'), 'check');
          it.onclick = () => pick(o);
        }
        if (q && !(col.options || []).includes(q)) {
          const it = listEl.createDiv({ cls: 'db-pop-item' });
          it.createSpan({ text: '创建 ' });
          it.createSpan({ cls: `db-chip tone-${hashTone(q)}`, text: q });
          it.onclick = () => { plugin.addOption(col, q); pick(q); };
        }
        if (value && !q) {
          const it = listEl.createDiv({ cls: 'db-pop-item db-muted-item', text: '清除' });
          it.onclick = () => pick('');
        }
      };
      input.oninput = draw;
      input.onkeydown = (e) => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        const q = input.value.trim();
        const hit = (col.options || []).find((o) => o === q) || (col.options || []).find((o) => o.includes(q));
        if (hit) pick(hit); else { plugin.addOption(col, q); pick(q); }
      };
      draw();
    }, 220);
    pop.querySelector('.db-pop-input').focus();
  }

  inlineEdit(el, value, save, opts = {}) {
    el.onclick = () => {
      if (el.querySelector('input')) return;
      el.empty();
      const input = el.createEl('input', { type: 'text', value: opts.editValue !== undefined ? opts.editValue : value });
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        const changed = commit && v && v !== (opts.editValue !== undefined ? opts.editValue : value);
        const saved = changed && save(v) !== false;
        el.empty();
        el.setText(saved ? v : value);
        if (this.dirty) this.render();
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      };
      input.onblur = () => finish(true);
    };
  }

  renderDetail(box, p) {
    const d = box.createDiv('db-detail');
    const left = d.createDiv('db-log');
    if (p.mentions.length) {
      left.createDiv({ cls: 'db-sub', text: '今天写到' });
      for (const line of p.mentions) {
        const row = left.createDiv('db-today-line');
        row.createSpan({ cls: 'db-today-text', text: line });
        const clean = this.plugin.cleanLine(line);
        const logged = p.log.some((x) => x.t === clean);
        const btn = row.createSpan({ cls: 'db-today-add' + (logged ? ' is-done' : ''), text: logged ? '已记入' : '记入时间线' });
        if (!logged) btn.onclick = () => this.plugin.addLog(p.key, clean);
      }
    }
    left.createDiv({ cls: 'db-sub', text: '时间线' });
    const input = left.createEl('input', { cls: 'db-log-add', type: 'text', placeholder: '记一条节点，回车（自动加今天日期）' });
    input.onkeydown = (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const text = input.value.trim();
      input.value = '';
      input.blur();
      this.plugin.addLog(p.key, text);
    };
    input.onblur = () => { if (this.dirty) this.render(); };
    if (!p.log.length) left.createDiv({ cls: 'db-muted', text: '还没有记录' });
    const ordered = p.log.map((item, idx) => ({ item, idx })).sort((a, b) => {
      const x = String(a.item.d).replace('~', ''), y = String(b.item.d).replace('~', '');
      return y.localeCompare(x) || b.idx - a.idx;
    });
    for (const { item, idx } of ordered) {
      const line = left.createDiv({ cls: 'db-log-line', attr: { 'data-idx': String(idx) } });
      const raw = String(item.d);
      const date = line.createSpan({ cls: 'db-log-date', text: raw.replace(/^(~?)\d{4}-/, '$1') });
      this.inlineEdit(date, date.textContent, (v) => this.plugin.editLogDate(p.key, idx, v), { editValue: raw });
      const text = line.createSpan({ cls: 'db-log-text', text: item.t });
      this.inlineEdit(text, item.t, (v) => this.plugin.editLog(p.key, idx, { t: v }));
      const del = line.createSpan({ cls: 'db-log-del', attr: { 'aria-label': '删除这一条' } });
      setIcon(del, 'x');
      del.onclick = () => this.plugin.removeLog(p.key, idx);
    }
    const right = d.createDiv('db-files');
    const sub = right.createDiv('db-sub');
    sub.createSpan({ text: '最近文件' });
    if (!p.virtual) {
      const reveal = sub.createEl('a', { cls: 'db-reveal', text: '定位文件夹' });
      reveal.onclick = () => this.plugin.reveal(p.key);
    }
    if (!p.files.length) right.createDiv({ cls: 'db-muted', text: p.virtual ? '还没有文件夹' : '文件夹是空的' });
    for (const f of p.files.slice(0, 7)) {
      const line = right.createDiv('db-file');
      const a = line.createEl('a', { text: f.path.slice(p.key.length + 1) });
      a.onclick = () => this.app.workspace.getLeaf(false).openFile(f);
      line.createSpan({ cls: 'db-muted', text: toDay(new Date(f.stat.mtime)).slice(5) });
    }
    right.createDiv({ cls: 'db-sub db-sub-gap', text: '也叫' });
    const alias = right.createEl('input', { cls: 'db-log-add db-alias', type: 'text', value: p.alias, placeholder: '别名，逗号分隔；工作台写到就自动关联' });
    const saveAlias = () => {
      const v = alias.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean).join('，');
      if (v !== p.alias) { p.alias = v; this.plugin.setAlias(p.key, v); }
    };
    alias.onkeydown = (e) => { if (e.key === 'Enter') alias.blur(); };
    alias.onblur = saveAlias;
  }

  openRowMenu(e, p) {
    const menu = new Menu();
    for (const lane of this.plugin.cfg.lanes) {
      menu.addItem((i) => i.setTitle(`移到：${lane.id}`).setChecked(p.lane === lane.id).onClick(() => this.plugin.setLane(p.key, lane.id)));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('保持常亮（不随时间变灰）').setIcon('sun').setChecked(p.keep).onClick(() => this.plugin.patch(p.key, { keep: !p.keep }, false)));
    menu.addItem((i) => i.setTitle(p.virtual ? '重命名' : '重命名（同时改文件夹名）').setIcon('pencil').onClick(() => { this.renaming = p.key; this.render(); }));
    if (p.virtual) {
      menu.addItem((i) => i.setTitle('建文件夹').setIcon('folder-plus').onClick(() => this.plugin.materialize(p)));
      menu.addItem((i) => i.setTitle('删除这一行').setIcon('trash-2').onClick(() => this.plugin.removeVirtual(p.key)));
    } else {
      menu.addItem((i) => i.setTitle('在文件列表中定位').setIcon('folder-open').onClick(() => this.plugin.reveal(p.key)));
      menu.addItem((i) => i.setTitle('从调度台隐藏（文件夹不动）').setIcon('eye-off').onClick(() => this.plugin.hideProject(p.key)));
    }
    menu.showAtMouseEvent(e);
  }

  startDrag(e, p, row) {
    if (e.button !== 0 || e.target.closest('.db-nodrag, input, a, select')) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null, laneEl = null, anchor = null, after = false;
    const clearRows = () => {
      this.contentEl.querySelectorAll('.db-row.is-before, .db-row.is-after').forEach((el) => el.removeClass('is-before', 'is-after'));
    };
    const markLane = (el) => {
      if (laneEl) laneEl.removeClass('is-drop');
      laneEl = el;
      if (laneEl) laneEl.addClass('is-drop');
    };
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!ghost) {
        ghost = document.body.createDiv({ cls: 'db-ghost', text: p.name });
        row.addClass('is-dragging');
        document.body.addClass('db-is-dragging');
      }
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 8 + 'px';
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      markLane(el && el.closest ? el.closest('.db-lane') : null);
      clearRows();
      anchor = null;
      const over = el && el.closest ? el.closest('.db-row') : null;
      if (over && over !== row) {
        const b = over.getBoundingClientRect();
        after = ev.clientY > b.top + b.height / 2;
        anchor = over.getAttribute('data-key');
        over.addClass(after ? 'is-after' : 'is-before');
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!ghost) return;
      ghost.remove();
      document.body.removeClass('db-is-dragging');
      row.removeClass('is-dragging');
      clearRows();
      this.suppressClick = true;
      setTimeout(() => { this.suppressClick = false; }, 200);
      const lane = laneEl && laneEl.getAttribute('data-lane');
      markLane(null);
      if (lane && lane !== INBOX) this.plugin.placeRow(p, lane, anchor, after);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }
}

// Only rare, structural things live here; everything else is edited in the table itself.
class DispatchSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const el = this.containerEl;
    el.empty();
    el.addClass('db-settings');
    const p = this.plugin;
    const cfg = p.cfg;
    const store = p.store;
    new Setting(el).setDesc('列、分组、选项、行都直接在调度台的表格里改。这里只放很少改动的东西。');

    new Setting(el).setName('提醒').setHeading();
    const num = (name, desc, key) => new Setting(el).setName(name).setDesc(desc).addText((t) => {
      t.setValue(String(cfg[key]));
      t.inputEl.type = 'number';
      t.inputEl.addEventListener('change', () => {
        const n = parseInt(t.getValue(), 10);
        if (n >= 0) { cfg[key] = n; p.saveConfig(); } else t.setValue(String(cfg[key]));
      });
    });
    num('多少天没动开始提醒', '行变淡一点，“没动”一列标红。', 'staleDays');
    num('多少天没动变灰沉底', '行变灰、沉到分组底部，不再提醒；一有动静自动恢复。', 'fadeDays');
    num('多少天内算刚动过', '“没动”一列标绿；日期列提前这么多天变橙。', 'freshDays');

    new Setting(el).setName('扫描范围').setHeading();
    const paths = (name, desc, key) => new Setting(el).setName(name).setDesc(desc).setClass('db-set-area').addTextArea((t) => {
      t.setValue(store[key].join('\n'));
      t.inputEl.addEventListener('change', () => {
        store[key] = t.getValue().split('\n').map((x) => x.trim()).filter(Boolean).map((x) => normalizePath(x));
        p.saveConfig();
      });
    });
    new Setting(el).setName('根目录').setDesc('一行一个，格式“路径 | 名字”。它的下一级文件夹就是项目。').setClass('db-set-area').addTextArea((t) => {
      t.setValue(store.roots.map((r) => `${r.path} | ${r.line}`).join('\n'));
      t.inputEl.addEventListener('change', () => {
        const next = t.getValue().split('\n').map((x) => x.trim()).filter(Boolean).map((x) => {
          const [path, line] = x.split('|').map((s) => s.trim());
          return { path: normalizePath(path), line: line || path.split('/').pop() };
        });
        if (next.length) { store.roots = next; p.saveConfig(); }
      });
    });
    paths('归档文件夹', '一行一个。它下面的文件夹默认进归档分组。', 'archive');
    paths('不算项目的文件夹', '一行一个。在调度台里隐藏的项目也记在这里，删掉这一行就恢复。', 'ignore');

    new Setting(el).setName('恢复默认').setHeading();
    new Setting(el).setName('恢复默认的列和分组').setDesc('只重置表格结构；项目数据、时间线都保留。').addButton((b) => b.setButtonText('恢复').setWarning().onClick(() => {
      store.config = clone(DEFAULT_CONFIG);
      p.saveConfig();
      new Notice('已恢复默认的列和分组');
      this.display();
    }));
  }
}

module.exports = class DispatchBoardPlugin extends Plugin {
  async onload() {
    this.store = null;
    this.lastWritten = null;
    await this.loadStore();
    this.registerView(VIEW_TYPE, (leaf) => new DispatchView(leaf, this));
    this.benchLines = [];
    this.addRibbonIcon('layout-list', '拉出 / 收起调度台', () => this.toggleDrawer());
    this.addCommand({ id: 'toggle', name: '拉出 / 收起调度台', callback: () => this.toggleDrawer() });
    this.addSettingTab(new DispatchSettings(this.app, this));
    // Typing in the workbench must not make the board redraw; only project files matter here.
    const inScope = (f) => this.store.roots.some((r) => f.path === r.path || f.path.startsWith(r.path + '/'));
    const touchFile = (f) => {
      if (f.path.startsWith(HISTORY_DIR + '/')) { this.histCache = null; this.refreshHistorySoon(); }
      else if (inScope(f)) this.refreshSoon();
    };
    this.registerEvent(this.app.vault.on('create', touchFile));
    this.registerEvent(this.app.vault.on('delete', touchFile));
    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (f.path === STORE_PATH) this.reloadFromDisk();
      else if (f.path === BENCH_PATH) this.refreshTodaySoon();
      else touchFile(f);
    }));
    const syncAction = () => this.syncBenchAction();
    this.registerEvent(this.app.workspace.on('layout-change', syncAction));
    this.registerEvent(this.app.workspace.on('active-leaf-change', syncAction));
    this.registerEvent(this.app.workspace.on('file-open', syncAction));
    this.app.workspace.onLayoutReady(async () => {
      await this.rollover();
      await this.refreshToday();
      await this.moveBoardToDrawer();
      this.syncBenchAction();
    });
    this.registerInterval(window.setInterval(() => this.rollover(), 60 * 1000));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.onRename(f, old)));
  }

  get cfg() { return this.store.config; }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  onunload() {
    for (const l of this.app.workspace.getLeavesOfType('markdown')) {
      if (l.view._dbAction) { l.view._dbAction.remove(); l.view._dbAction = null; }
    }
  }

  // The toggle lives in the workbench's own header, right next to what you are writing.
  syncBenchAction() {
    for (const l of this.app.workspace.getLeavesOfType('markdown')) {
      const v = l.view;
      const isBench = v.file && v.file.path === BENCH_PATH;
      if (isBench && !v._dbAction) v._dbAction = v.addAction('layout-list', '拉出 / 收起调度台', () => this.toggleDrawer());
      else if (!isBench && v._dbAction) { v._dbAction.remove(); v._dbAction = null; }
    }
  }

  drawerLeaf() {
    const ws = this.app.workspace;
    return ws.getLeavesOfType(VIEW_TYPE).find((l) => l.getRoot() === ws.rightSplit);
  }

  // Earlier versions opened the board as a tab in the main area.
  async moveBoardToDrawer() {
    const ws = this.app.workspace;
    const isStray = (l) => l.getRoot() !== ws.rightSplit;
    if (!ws.getLeavesOfType(VIEW_TYPE).some(isStray)) return;
    // Open today first: closing the last main tab before that leaves nowhere stable to open it.
    await this.openBench(false);
    for (const l of ws.getLeavesOfType(VIEW_TYPE).filter(isStray)) l.detach();
    await this.openDrawer();
  }

  async ensureDrawerLeaf() {
    const ws = this.app.workspace;
    let leaf = this.drawerLeaf();
    if (!leaf) {
      leaf = ws.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    return leaf;
  }

  async openDrawer() {
    const ws = this.app.workspace;
    const leaf = await this.ensureDrawerLeaf();
    const split = ws.rightSplit;
    const leftWidth = ws.leftSplit && !ws.leftSplit.collapsed ? ws.leftSplit.containerEl.getBoundingClientRect().width : 0;
    const room = window.innerWidth - leftWidth - 340;
    const target = Math.max(420, Math.min(Math.round(window.innerWidth * 0.62), 1180, room));
    // First pull only, or when the window got too small; otherwise the width you dragged it to is kept.
    const tooNarrow = !split.size || split.size < 420 || split.size > room;
    if (tooNarrow && split.setSize) split.setSize(target);
    await ws.revealLeaf(leaf);
    if (split.collapsed) split.expand();
    if (tooNarrow) {
      window.setTimeout(() => {
        const el = split.containerEl;
        if (!split.collapsed && Math.abs(el.getBoundingClientRect().width - target) > 4) {
          split.setSize(target);
          el.style.width = target + 'px';
        }
      }, 400);
    }
  }

  async toggleDrawer() {
    const ws = this.app.workspace;
    const split = ws.rightSplit;
    const leaf = this.drawerLeaf();
    const showing = leaf && !split.collapsed && leaf.parent && leaf.parent.children[leaf.parent.currentTab] === leaf;
    if (showing) { split.collapse(); return; }
    await this.openBench(false);
    await this.openDrawer();
  }

  async activate() {
    await this.openBench(false);
    await this.openDrawer();
  }

  benchLeaf() {
    const isBench = (l) => {
      if (l.view && l.view.file) return l.view.file.path === BENCH_PATH;
      const st = l.getViewState();
      return !!(st && st.state && st.state.file === BENCH_PATH);
    };
    return this.app.workspace.getLeavesOfType('markdown').find((l) => isBench(l) && l.getRoot() === this.app.workspace.rootSplit)
      || this.app.workspace.getLeavesOfType('markdown').find(isBench);
  }

  // Today is the ordinary note in the main area, so images, links and every editor plugin keep working.
  async openBench(focus) {
    const ws = this.app.workspace;
    const file = this.app.vault.getAbstractFileByPath(BENCH_PATH);
    if (!(file instanceof TFile)) { new Notice('没有找到 ' + BENCH_PATH); return; }
    let leaf = this.benchLeaf();
    if (!leaf) {
      leaf = ws.getLeaf(false);
      await leaf.openFile(file);
    } else if (leaf.getRoot() === ws.rootSplit && leaf.parent && leaf.parent.children[leaf.parent.currentTab] !== leaf) {
      ws.revealLeaf(leaf);
    }
    if (focus) ws.setActiveLeaf(leaf, { focus: true });
    this.syncBenchAction();
  }

  // ---------- link today's notes to projects by name or alias; no model involved ----------
  refreshTodaySoon() {
    window.clearTimeout(this.todayTimer);
    this.todayTimer = window.setTimeout(() => this.refreshToday(), 500);
  }

  async refreshToday() {
    const f = this.app.vault.getAbstractFileByPath(BENCH_PATH);
    if (!(f instanceof TFile)) return;
    const text = await this.app.vault.read(f);
    this.benchLines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d{1,2}\.\d{1,2}$/.test(l) && !l.startsWith('![[') && !l.startsWith('```'));
    const sig = JSON.stringify(this.projects().filter((p) => p.mentions.length).map((p) => [p.key, p.mentions]));
    if (sig !== this.mentionSig) {
      this.mentionSig = sig;
      this.refreshSoon();
    }
  }

  cleanLine(line) {
    return line.replace(/^[-*+]\s+(\[.\]\s+)?/, '').replace(/^\d+[.、)）]?\s*/, '').trim();
  }

  setAlias(key, v) {
    const cur = this.entry(key);
    if (v) cur.alias = v; else delete cur.alias;
    this.mentionSig = null;
    this.save();
    this.refreshToday();
  }

  refreshHistorySoon() {
    window.clearTimeout(this.histTimer);
    this.histTimer = window.setTimeout(() => {
      for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (l.view.page === 'history') l.view.requestRender();
    }, 200);
  }

  // ---------- daily rollover ----------
  // History is written and verified first; the workbench is only trimmed afterwards, so nothing can be lost.
  async rollover() {
    if (this.rolling) return;
    this.rolling = true;
    try {
      const v = this.app.vault;
      const file = v.getAbstractFileByPath(BENCH_PATH);
      if (!(file instanceof TFile)) return;
      const now = today();
      const text = await v.read(file);
      const blocks = splitDays(text, toDay(new Date(file.stat.mtime)), headingDay);
      const moved = blocks.filter((b) => b.day < now);
      const hasToday = blocks.some((b) => b.hasHead && b.day === now);
      if (!moved.length && hasToday) return;
      if (Date.now() - file.stat.mtime < ROLL_IDLE_MS) return; // still typing; try again later
      const filled = moved.filter((b) => b.body);
      await this.appendHistory(filled);
      const d = new Date();
      const heading = `${d.getMonth() + 1}.${d.getDate()}`;
      await v.process(file, (data) => {
        let out = data;
        for (const b of moved) out = out.replace(b.raw, () => '');
        out = out.replace(/^\s+/, '');
        const keepsToday = splitDays(out, now, headingDay).some((b) => b.hasHead && b.day === now);
        return keepsToday ? out : `${heading}\n\n${out}`;
      });
      this.histCache = null;
      this.refreshHistorySoon();
      const days = new Set(filled.map((b) => b.day)).size;
      if (days) new Notice(`已翻篇：${days} 天的记录进了历史`);
    } catch (err) {
      console.error('调度台翻篇失败', err);
      new Notice('翻篇没有完成，工作台内容没动：' + err.message);
    } finally {
      this.rolling = false;
    }
  }

  async appendHistory(blocks) {
    if (!blocks.length) return;
    const a = this.app.vault.adapter;
    if (!(await a.exists(HISTORY_DIR))) await a.mkdir(HISTORY_DIR);
    const byMonth = new Map();
    for (const b of [...blocks].sort((x, y) => x.day.localeCompare(y.day))) {
      const m = b.day.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) || '') + `## ${b.day}\n\n${b.body}\n\n`);
    }
    for (const [month, chunk] of byMonth) {
      const path = `${HISTORY_DIR}/${month}.md`;
      const existing = (await a.exists(path)) ? await a.read(path) : '';
      const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
      await a.write(path, existing + sep + chunk);
      const back = await a.read(path);
      if (!back.includes(chunk)) throw new Error(`历史文件校验失败：${path}`);
    }
  }

  async readHistory() {
    if (this.histCache) return this.histCache;
    const entries = [];
    const others = [];
    const folder = this.app.vault.getAbstractFileByPath(HISTORY_DIR);
    if (folder instanceof TFolder) {
      for (const f of folder.children) {
        if (!(f instanceof TFile) || f.extension !== 'md') continue;
        if (!/^\d{4}-\d{2}$/.test(f.basename)) { others.push(f); continue; }
        const text = await this.app.vault.cachedRead(f);
        const matcher = (line) => { const m = line.match(/^## (20\d\d-\d\d-\d\d)\s*$/); return m ? m[1] : null; };
        splitDays(text, f.basename + '-01', matcher).forEach((b, seq) => {
          if (!b.hasHead || !b.body) return;
          const first = b.body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('![[') && !l.startsWith('```') && !/^[-*_]{3,}$/.test(l) && !/^\|?[\s:|-]+\|?$/.test(l)) || '（图片）';
          const preview = first.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, (_, t) => t.split('/').pop()).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*#>`|]/g, '').trim();
          entries.push({ day: b.day, body: b.body, path: f.path, seq, preview: preview.slice(0, 90) });
        });
      }
    }
    entries.sort((a, b) => a.day.localeCompare(b.day) || a.seq - b.seq);
    const byDay = new Map();
    for (const e of entries) {
      const cur = byDay.get(e.day);
      if (cur) cur.body += `\n\n${e.body}`; else byDay.set(e.day, e);
    }
    entries.length = 0;
    entries.push(...[...byDay.values()].reverse());
    others.sort((a, b) => b.basename.localeCompare(a.basename));
    this.histCache = { entries, others };
    return this.histCache;
  }

  refreshSoon() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) l.view.requestRender();
    }, 150);
  }

  withDefaults(raw) {
    const store = Object.assign(clone(DEFAULT_STORE), raw);
    store.config = Object.assign(clone(DEFAULT_CONFIG), raw.config || {});
    const s = store.config.sort;
    if (s !== 'manual' && (typeof s !== 'object' || !s || !s.key)) store.config.sort = clone(DEFAULT_CONFIG.sort);
    for (const c of store.config.columns) if (c.kind === 'line' && c.label === '线') c.label = 'Type';
    return store;
  }

  async loadStore() {
    const a = this.app.vault.adapter;
    if (await a.exists(STORE_PATH)) {
      try {
        this.store = this.withDefaults(JSON.parse(await a.read(STORE_PATH)));
      } catch (err) {
        new Notice('调度台数据文件格式有误，请检查 ' + STORE_PATH);
        this.store = this.withDefaults({});
        this.broken = true;
      }
    } else {
      this.store = this.withDefaults({});
      await this.save();
    }
  }

  async reloadFromDisk() {
    const text = await this.app.vault.adapter.read(STORE_PATH);
    if (text === this.lastWritten) return;
    try {
      this.store = this.withDefaults(JSON.parse(text));
      this.broken = false;
      this.refreshSoon();
    } catch (err) {
      new Notice('调度台数据文件格式有误，暂未载入：' + STORE_PATH);
    }
  }

  async save() {
    if (this.broken) { new Notice('数据文件有误，修好后才能保存'); return; }
    this.lastWritten = JSON.stringify(this.store, null, 2) + '\n';
    await this.app.vault.adapter.write(STORE_PATH, this.lastWritten);
  }

  saveConfig() {
    this.save();
    this.refreshSoon();
  }

  projects() {
    const v = this.app.vault;
    const cfg = this.cfg;
    const laneIds = cfg.lanes.map((l) => l.id);
    const archiveLane = (cfg.lanes.find((l) => l.archive) || {}).id;
    const found = new Map();
    const add = (folder, line, archived) => found.set(folder.path, { folder, line, archived });
    const ignore = this.store.ignore;
    for (const r of this.store.roots) {
      const root = v.getAbstractFileByPath(r.path);
      if (!(root instanceof TFolder)) continue;
      for (const c of root.children) {
        if (!(c instanceof TFolder) || ignore.includes(c.path)) continue;
        if (this.store.archive.includes(c.path)) {
          for (const a of c.children) if (a instanceof TFolder && !ignore.includes(a.path)) add(a, r.line, true);
        } else add(c, r.line, false);
      }
    }
    const levels = cfg.levels.map((l) => l.id);
    const fallback = levels[Math.floor((levels.length - 1) / 2)];
    const out = [];
    const typeOf = (root) => {
      if (!root) return '';
      if (root.type) return root.type;
      const name = root.path.split('/').pop().toLowerCase();
      if (name === 'work') return 'W';
      if (name === 'personal') return 'P';
      return name.slice(0, 1).toUpperCase();
    };
    const build = (key, s, info) => {
      const files = info ? collectFiles(info.folder).sort((a, b) => b.stat.mtime - a.stat.mtime) : [];
      const fileTime = files.length ? files[0].stat.mtime : 0;
      const stateTime = s.touched ? new Date(s.touched + 'T12:00:00').getTime() : 0;
      const touched = Math.max(fileTime, stateTime) || null;
      const level = levels.includes(s.level) ? s.level : fallback;
      const firstLine = this.store.roots[0] ? this.store.roots[0].line : '';
      const home = this.store.roots.find((r) => key.startsWith(r.path + '/'));
      const defaultLane = info && info.archived && archiveLane ? archiveLane : INBOX;
      const aliases = [key.split('/').pop(), ...String(s.alias || '').split(/[,，、]/)].map((x) => x.trim().toLowerCase()).filter(Boolean);
      const mentions = (this.benchLines || []).filter((l) => { const t = l.toLowerCase(); return aliases.some((a) => t.includes(a)); });
      const days = daysSince(touched);
      const fade = s.keep ? 0 : (days === null || days > cfg.fadeDays ? 2 : days > cfg.staleDays ? 1 : 0);
      out.push({
        key,
        name: key.split('/').pop(),
        line: info ? info.line : (home ? home.line : firstLine),
        type: typeOf(home),
        virtual: !info,
        lane: laneIds.includes(s.lane) ? s.lane : defaultLane,
        level,
        levelRank: levels.length - levels.indexOf(level),
        stage: s.stage || '',
        node: s.node || '',
        next: s.next || '',
        fields: s.fields || {},
        order: s.order,
        log: s.log || [],
        files,
        touched,
        days,
        fade,
        keep: !!s.keep,
        alias: s.alias || '',
        mentions,
      });
    };
    for (const [key, info] of found) build(key, this.store.projects[key] || {}, info);
    for (const [key, s] of Object.entries(this.store.projects)) {
      if (!found.has(key) && s.virtual && !ignore.includes(key)) build(key, s, null);
    }
    return out;
  }

  // Grayed-out projects always sink below the live ones, whatever the sort.
  compareRows(a, b) {
    return (a.fade === 2) - (b.fade === 2) || this.compare(a, b);
  }

  compare(a, b) {
    const sort = this.cfg.sort;
    const far = 1e9;
    const tie = () => b.levelRank - a.levelRank || (a.days ?? far) - (b.days ?? far) || a.name.localeCompare(b.name, 'zh');
    if (sort === 'manual') return (a.order ?? far) - (b.order ?? far) || tie();
    const col = this.cfg.columns.find((c) => c.key === sort.key);
    if (!col) return tie();
    const mul = sort.dir === 'desc' ? -1 : 1;
    const stages = this.cfg.stages;
    let x, y;
    if (col.kind === 'level') { x = -a.levelRank; y = -b.levelRank; }
    else if (col.kind === 'days') { x = a.days; y = b.days; }
    else if (col.kind === 'stage') { x = stages.indexOf(a.stage); y = stages.indexOf(b.stage); if (x < 0) x = null; if (y < 0) y = null; }
    else if (col.kind === 'name') { x = a.name; y = b.name; }
    else if (col.kind === 'line') { x = a.line; y = b.line; }
    else { x = this.value(a, col) || null; y = this.value(b, col) || null; }
    if ((x === null || x === undefined) && (y === null || y === undefined)) return tie();
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'zh');
    return c ? c * mul : tie();
  }

  value(p, col) {
    if (col.key === 'node' || col.key === 'next') return p[col.key] || '';
    return (p.fields && p.fields[col.key]) || '';
  }

  valuesOf(col) {
    const seen = new Set();
    this.eachProject((s) => { if (s.fields && s.fields[col.key]) seen.add(s.fields[col.key]); });
    return [...seen];
  }

  setValue(key, col, v) {
    if (col.key === 'node' || col.key === 'next') { this.patch(key, { [col.key]: v }); return; }
    const cur = this.entry(key);
    cur.fields = cur.fields || {};
    if (v) cur.fields[col.key] = v; else delete cur.fields[col.key];
    cur.touched = today();
    this.saveConfig();
  }

  entry(key) { return this.store.projects[key] || (this.store.projects[key] = {}); }

  patch(key, fields, stamp = true) {
    const cur = this.entry(key);
    Object.assign(cur, fields);
    if (stamp) cur.touched = today();
    this.saveConfig();
  }

  // Moving a project to a live group counts as activity, so it lights back up; archiving does not.
  stampMove(key, lane) {
    const def = this.cfg.lanes.find((l) => l.id === lane);
    if (!def || !def.archive) this.entry(key).touched = today();
  }

  setLane(key, lane) {
    this.entry(key).lane = lane;
    this.stampMove(key, lane);
    this.saveConfig();
  }

  // Turn the current automatic order into explicit positions so a manual drop has something to land in.
  ensureManual() {
    if (this.cfg.sort === 'manual') return;
    const all = this.projects();
    for (const lane of new Set(all.map((p) => p.lane))) {
      all.filter((p) => p.lane === lane).sort((a, b) => this.compareRows(a, b)).forEach((p, i) => { this.entry(p.key).order = i; });
    }
    this.cfg.sort = 'manual';
  }

  placeRow(p, lane, anchorKey, after) {
    const sameLane = lane === p.lane;
    if (sameLane && !anchorKey) return;
    if (!sameLane && this.cfg.sort !== 'manual') { this.setLane(p.key, lane); return; }
    this.ensureManual();
    const list = this.projects().filter((x) => x.lane === lane && x.key !== p.key).sort((a, b) => this.compareRows(a, b)).map((x) => x.key);
    const at = anchorKey && list.includes(anchorKey) ? list.indexOf(anchorKey) + (after ? 1 : 0) : list.length;
    list.splice(at, 0, p.key);
    list.forEach((k, i) => { this.entry(k).order = i; });
    this.entry(p.key).lane = lane;
    if (!sameLane) this.stampMove(p.key, lane);
    this.saveConfig();
  }

  cycleLevel(key) {
    const ids = this.cfg.levels.map((l) => l.id);
    const p = this.projects().find((x) => x.key === key);
    const next = ids[(ids.indexOf(p ? p.level : ids[0]) + 1) % ids.length];
    this.patch(key, { level: next }, false);
  }

  addLog(key, text) {
    const cur = this.entry(key);
    cur.log = cur.log || [];
    cur.log.push({ d: today(), t: text });
    cur.touched = today();
    this.saveConfig();
  }

  editLog(key, idx, fields) {
    const log = this.entry(key).log || [];
    if (log[idx]) Object.assign(log[idx], fields);
    this.saveConfig();
  }

  editLogDate(key, idx, value) {
    const m = value.trim().match(/^(~?)(?:(\d{4})-)?(\d{1,2})[-.](\d{1,2})$/);
    if (!m) { new Notice('日期写成 2026-11-03 或 11-03'); return false; }
    const year = m[2] || String(new Date().getFullYear());
    this.editLog(key, idx, { d: `${m[1]}${year}-${pad(Number(m[3]))}-${pad(Number(m[4]))}` });
  }

  removeLog(key, idx) {
    const log = this.entry(key).log || [];
    log.splice(idx, 1);
    this.saveConfig();
  }

  // ---------- structure edits: every rename carries existing project data along ----------
  dup(list, v, what) {
    if (v === INBOX || list.includes(v)) { new Notice(`已经有“${v}”这个${what}了`); return true; }
    return false;
  }

  eachProject(fn) { for (const s of Object.values(this.store.projects)) fn(s); }

  uniqueName(base, taken) {
    if (!taken.includes(base)) return base;
    let n = 2;
    while (taken.includes(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  renameLane(lane, v) {
    if (this.dup(this.cfg.lanes.map((l) => l.id), v, '分组')) return false;
    this.eachProject((s) => { if (s.lane === lane.id) s.lane = v; });
    lane.id = v;
  }
  addLaneAuto(at) {
    const id = this.uniqueName('新分组', this.cfg.lanes.map((l) => l.id));
    const archiveAt = this.cfg.lanes.findIndex((l) => l.archive);
    const pos = at !== undefined ? at : (archiveAt < 0 ? this.cfg.lanes.length : archiveAt);
    this.cfg.lanes.splice(pos, 0, { id, hint: '' });
    this.save();
    return id;
  }
  removeLane(lane) { this.cfg.lanes.splice(this.cfg.lanes.indexOf(lane), 1); }

  renameStage(old, v) {
    const list = this.cfg.stages;
    if (this.dup(list, v, '阶段')) return false;
    this.eachProject((s) => { if (s.stage === old) s.stage = v; });
    list[list.indexOf(old)] = v;
    this.saveConfig();
  }
  addStage(v) { if (this.dup(this.cfg.stages, v, '阶段')) return false; this.cfg.stages.push(v); }
  removeStage(v) {
    this.cfg.stages.splice(this.cfg.stages.indexOf(v), 1);
    this.eachProject((s) => { if (s.stage === v) delete s.stage; });
  }

  renameLevel(level, v) {
    if (this.dup(this.cfg.levels.map((l) => l.id), v, '级别')) return false;
    this.eachProject((s) => { if (s.level === level.id) s.level = v; });
    level.id = v;
    this.saveConfig();
  }
  addLevel(v) {
    if (this.dup(this.cfg.levels.map((l) => l.id), v, '级别')) return false;
    this.cfg.levels.push({ id: v, color: '' });
  }
  removeLevel(level) {
    this.cfg.levels.splice(this.cfg.levels.indexOf(level), 1);
    this.eachProject((s) => { if (s.level === level.id) delete s.level; });
  }

  renameOption(col, old, v) {
    if (col.options.includes(v)) { new Notice('已经有这个选项了'); return false; }
    this.eachProject((s) => { if (s.fields && s.fields[col.key] === old) s.fields[col.key] = v; });
    col.options[col.options.indexOf(old)] = v;
    this.saveConfig();
  }
  addOption(col, v) {
    col.options = col.options || [];
    if (col.options.includes(v)) return false;
    col.options.push(v);
    this.save();
  }
  removeOption(col, v) {
    col.options.splice(col.options.indexOf(v), 1);
    this.eachProject((s) => { if (s.fields && s.fields[col.key] === v) delete s.fields[col.key]; });
  }

  renameColumn(col, v) {
    if (!col.custom) { col.label = v; return; }
    if (this.dup(this.cfg.columns.map((c) => c.key), v, '列')) return false;
    this.eachProject((s) => {
      if (s.fields && col.key in s.fields) { s.fields[v] = s.fields[col.key]; delete s.fields[col.key]; }
    });
    if (this.cfg.sort !== 'manual' && this.cfg.sort.key === col.key) this.cfg.sort.key = v;
    col.key = v;
    col.label = v;
  }
  newColumn(v, kind) {
    const col = { key: v, label: v, kind, show: true, custom: true };
    if (kind === 'select') col.options = this.valuesOfKey(v);
    return col;
  }
  valuesOfKey(key) {
    const seen = new Set();
    this.eachProject((s) => { if (s.fields && s.fields[key]) seen.add(s.fields[key]); });
    return [...seen];
  }
  addColumn(v, kind) {
    if (this.dup(this.cfg.columns.map((c) => c.key), v, '列')) return false;
    const at = this.cfg.columns.findIndex((c) => c.kind === 'days');
    this.cfg.columns.splice(at < 0 ? this.cfg.columns.length : at, 0, this.newColumn(v, kind));
  }
  addColumnAt(refKey, offset) {
    const key = this.uniqueName('新列', this.cfg.columns.map((c) => c.key));
    const at = this.cfg.columns.findIndex((c) => c.key === refKey);
    this.cfg.columns.splice(at + offset, 0, this.newColumn(key, 'text'));
    this.save();
    return key;
  }
  moveColumn(key, overKey, after) {
    const cols = this.cfg.columns;
    const col = cols.find((c) => c.key === key);
    cols.splice(cols.indexOf(col), 1);
    cols.splice(cols.findIndex((c) => c.key === overKey) + (after ? 1 : 0), 0, col);
    this.saveConfig();
  }
  removeColumn(col) {
    this.cfg.columns.splice(this.cfg.columns.indexOf(col), 1);
    if (this.cfg.sort !== 'manual' && this.cfg.sort.key === col.key) this.cfg.sort = clone(DEFAULT_CONFIG.sort);
  }

  // ---------- rows ----------
  async createProject(name, line, lane) {
    const root = this.store.roots.find((r) => r.line === line) || this.store.roots[0];
    const clean = name.replace(/[\\/:*?"<>|#^\[\]]/g, ' ').trim();
    if (!root || !clean) return;
    const path = normalizePath(`${root.path}/${clean}`);
    if (this.app.vault.getAbstractFileByPath(path)) { new Notice('已经有这个项目了'); return; }
    await this.app.vault.createFolder(path);
    this.store.projects[path] = { lane: lane || (this.cfg.lanes[0] || {}).id, touched: today() };
    if (this.cfg.sort === 'manual') this.store.projects[path].order = 1e6;
    await this.save();
    this.refreshSoon();
  }

  async renameProject(p, name) {
    const clean = name.replace(/[\\/:*?"<>|#^\[\]]/g, ' ').trim();
    if (!clean) return;
    const parent = p.key.split('/').slice(0, -1).join('/');
    const next = normalizePath(`${parent}/${clean}`);
    if (this.app.vault.getAbstractFileByPath(next) || this.store.projects[next]) { new Notice('已经有这个名字了'); return; }
    if (p.virtual) {
      this.store.projects[next] = this.store.projects[p.key];
      delete this.store.projects[p.key];
      await this.save();
      return;
    }
    await this.app.fileManager.renameFile(this.app.vault.getAbstractFileByPath(p.key), next);
  }

  async materialize(p) {
    await this.app.vault.createFolder(p.key);
    delete this.entry(p.key).virtual;
    this.saveConfig();
  }

  removeVirtual(key) {
    delete this.store.projects[key];
    this.saveConfig();
  }

  hideProject(key) {
    if (!this.store.ignore.includes(key)) this.store.ignore.push(key);
    this.saveConfig();
    new Notice('已隐藏，文件夹没动。要恢复，在设置里的“不算项目的文件夹”删掉这一行。');
  }

  onRename(file, old) {
    if (file instanceof TFolder) {
      let changed = false;
      const archiveLane = (this.cfg.lanes.find((l) => l.archive) || {}).id;
      for (const key of Object.keys(this.store.projects)) {
        if (key === old || key.startsWith(old + '/')) {
          const next = file.path + key.slice(old.length);
          this.store.projects[next] = this.store.projects[key];
          delete this.store.projects[key];
          if (archiveLane && this.store.archive.some((a) => next.startsWith(a + '/'))) this.store.projects[next].lane = archiveLane;
          changed = true;
        }
      }
      if (changed) this.save();
    }
    this.refreshSoon();
  }

  reveal(key) {
    const folder = this.app.vault.getAbstractFileByPath(key);
    const ex = this.app.internalPlugins.getEnabledPluginById('file-explorer');
    if (folder && ex) ex.revealInFolder(folder);
  }
};
