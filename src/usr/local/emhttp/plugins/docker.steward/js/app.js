/* Docker Steward - page logic. Plain JS; jQuery (already on every Unraid page)
 * is used only for POSTs so the webGUI's CSRF token is attached. */
(function () {
  'use strict';
  const BASE = '/plugins/docker.steward/php/';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CHIP = {
    available: ['Update available', 'avail'],
    rebuild:   ['Rebuild needed',   'bad'],
    unknown:   ['Not checked',      'unk'],
    current:   ['Up to date',       'ok'],
  };
  const WHY = {
    compose:    'Managed by Compose, so update it there.',
    unmanaged:  'Not created from an Unraid template.',
    notemplate: 'No Unraid template found for this container.',
  };
  // Order = order on the page. 'open' is the default; a search opens every section.
  const GROUPS = [
    { id: 'needs',     title: 'Needs update',                 open: true,  test: (r) => r.can && r.verdict === 'available' },
    { id: 'unchecked', title: 'Not checked yet',              open: true,  test: (r) => r.can && (r.verdict === 'unknown' || r.verdict === 'rebuild') },
    { id: 'current',   title: 'Up to date',                   open: false, test: (r) => r.can && r.verdict === 'current' },
    { id: 'nocan',     title: 'Cannot be updated here',       open: false, test: (r) => !r.can },
  ];

  const SORTS = ['n', 'name', 'image', 'running', 'checked'];
  const S = {
    rows: [], compat: null, full: 0, skew: 0, loadedAt: 0,
    sel: new Set(), q: '',
    sort: loadJson('stw.sort', { key: 'n', dir: 1 }),
    open: loadJson('stw.open', {}),
    queue: [], working: false, total: 0, done: 0,
    pending: new Map(), errors: new Map(),
    run: null, sub: false, popup: false, snap: '', notice: null, menuFor: null, pollTimer: null,
  };

  // Stored settings are only ever used after being checked, never trusted as-is.
  function loadJson(k, d) {
    try {
      const v = JSON.parse(localStorage.getItem(k)) || {};
      if (k === 'stw.sort') return { key: SORTS.includes(v.key) ? v.key : d.key, dir: v.dir === -1 ? -1 : 1 };
      if (k === 'stw.open') { const o = {}; for (const g of GROUPS) if (typeof v[g.id] === 'boolean') o[g.id] = v[g.id]; return o; }
    } catch (e) {}
    return d;
  }
  function saveJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  const nowSec = () => Date.now() / 1000 + S.skew;
  function ago(ts) {
    if (!ts) return 'never';
    const d = Math.max(0, nowSec() - ts);
    if (d < 45) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    return Math.round(d / 86400) + ' d ago';
  }
  function post(file, data) {
    const body = Object.assign({}, data);
    if (window.csrf_token) body.csrf_token = window.csrf_token;
    return new Promise((resolve) => {
      jQuery.post(BASE + file, body).done((r) => resolve(r || {})).fail((x) => {
        let r = {}; try { r = JSON.parse(x.responseText); } catch (e) {}
        resolve(Object.assign({ ok: false, code: 'http' + x.status }, r));
      });
    });
  }
  const updatesOk = () => !S.compat || S.compat.updates;
  const runActive = () => !!(S.run && !S.run.finished);
  const find = (name) => S.rows.find((r) => r.name === name);
  const runItem = (name) => (S.run ? S.run.items.find((i) => i.name === name) : null);
  const isOpen = (g) => S.q.trim() !== '' || (g.id in S.open ? S.open[g.id] : g.open);
  const disabled = (el) => el.getAttribute('aria-disabled') === 'true';

  /* --------------------------------------------------------------- data */
  async function load() {
    let r;
    try { r = await (await fetch(BASE + 'list.php', { cache: 'no-store', credentials: 'same-origin' })).json(); }
    catch (e) { $('stw-status').textContent = 'Could not load containers. Reload the page.'; return; }
    S.rows = r.rows; S.full = r.full; S.skew = r.now - Date.now() / 1000; S.loadedAt = Date.now();
    S.run = r.run; S.compat = r.compat;
    for (const n of [...S.sel]) if (!find(n)) S.sel.delete(n);
    render();
    if (runActive()) { subscribe(); if (!S.popup) hold(); poll(); }
  }

  function shown() {
    const q = S.q.trim().toLowerCase();
    const key = S.sort.key;
    const val = (r) => key === 'running' ? (r.running ? (r.paused ? 1 : 0) : 2)
      : key === 'n' || key === 'checked' ? r[key] : String(r[key]).toLowerCase();
    return S.rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.image.toLowerCase().includes(q))
      .map((r, i) => [r, i]).sort((a, b) => {
        const x = val(a[0]), y = val(b[0]);
        return x === y ? a[1] - b[1] : (x < y ? -1 : 1) * S.sort.dir;
      }).map((p) => p[0]);
  }

  /* ---------------------------------------------------------- rendering */
  function statCell(r) {
    const it = runItem(r.name), p = S.pending.get(r.name);
    let chip;
    // A finished run's "Updated" chip must not hide a newer update found since.
    if (it && (runActive() || it.state === 'failed' || r.verdict !== 'available')) {
      const m = { queued: ['Queued', 'unk'], running: ['Updating…', 'busy'], done: ['Updated ✓', 'ok'], unchanged: ['Already current', 'unk'], failed: ['Update failed', 'bad'] }[it.state];
      chip = `<span class="stw-chip ${m[1]}">${m[0]}</span>`;
    } else if (p) {
      chip = `<span class="stw-chip busy">${p === 'checking' ? 'Checking…' : 'Waiting…'}</span>`;
    } else {
      const c = CHIP[r.verdict];
      chip = `<span class="stw-chip ${c[1]}">${c[0]}</span>`;
    }
    let sub = '';
    if (r.verdict === 'available' && r.local && r.remote) sub = `<code>${esc(r.local)}</code> → <code>${esc(r.remote)}</code>`;
    else if (r.local && r.verdict === 'current') sub = `<code>${esc(r.local)}</code>`;
    const when = r.checked ? `checked ${ago(r.checked)}` : '';
    const note = r.can ? '' : esc(WHY[r.why] || '');
    const err = S.errors.get(r.name);
    return `${chip}<span class="stw-sub">${[sub, when].filter(Boolean).join(' · ')}</span>`
      + (note ? `<span class="stw-sub">${note}</span>` : '') + (err ? `<span class="stw-err">${esc(err)}</span>` : '');
  }

  function actCell(r) {
    const off = runActive() || S.pending.has(r.name) ? ' aria-disabled="true"' : '';
    const main = r.can && updatesOk() && r.verdict === 'available'
      ? `<button type="button" class="stw-btn stw-main" data-act="update"${off}>Update</button>`
      : `<button type="button" class="stw-btn" data-act="check"${off}>${r.verdict === 'current' ? 'Re-check' : 'Check'}</button>`;
    return main + `<button type="button" class="stw-btn stw-sq" data-act="menu" aria-label="More actions for ${esc(r.name)}" aria-haspopup="menu"${off}>⋮</button>`;
  }

  function rowHtml(r) {
    const cls = r.paused ? 'paused' : r.running ? 'on' : 'off';
    const label = r.paused ? 'Paused' : r.running ? 'Started' : 'Stopped';
    const it = runItem(r.name);
    const icon = r.icon ? `<img src="${esc(r.icon)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    return `<li class="stw-row${it && it.state === 'running' ? ' working' : ''}" data-name="${esc(r.name)}">
      <input type="checkbox" class="stw-cb" data-act="sel" aria-label="Select ${esc(r.name)}"${S.sel.has(r.name) ? ' checked' : ''}>
      <span class="stw-ico">${icon}</span>
      <div class="stw-who"><div class="stw-title"><span class="stw-nm">${esc(r.name)}</span><span class="stw-st ${cls}" title="${label}"><i></i>${label}</span><span class="stw-prio" title="Priority on the Docker page">#${r.n}</span></div>
        <div class="stw-img">${esc(r.image)}</div></div>
      <div class="stw-stat">${statCell(r)}</div>
      <div class="stw-act">${actCell(r)}</div>
      ${it && it.state === 'running' ? '<div class="stw-prog"><i></i></div>' : ''}</li>`;
  }

  function renderGroups() {
    const list = shown();
    const html = GROUPS.map((g) => {
      const rows = list.filter(g.test);
      if (!rows.length) return '';
      const open = isOpen(g);
      let acts = '';
      const off = runActive() || S.working ? ' aria-disabled="true"' : '';
      const n = rows.filter((r) => S.sel.has(r.name)).length;
      const all = `<label class="stw-allsel"><input type="checkbox" data-act="selgroup" data-g="${g.id}"${n === rows.length ? ' checked' : ''}> all</label>`;
      if (g.id === 'needs') {
        acts = `<button type="button" class="stw-btn stw-main" data-act="update-group"${runActive() ? ' aria-disabled="true"' : ''}>Update all (${rows.length})</button>`;
      } else if (g.id === 'unchecked') {
        acts = `<button type="button" class="stw-btn" data-act="check-group" data-g="${g.id}"${off}>Check these (${rows.length})</button>`;
      }
      acts = all + acts;
      return `<section class="stw-group ${g.id}">
        <header><button type="button" class="stw-fold" data-act="fold" data-g="${g.id}" aria-expanded="${open}"><span class="stw-chev">▸</span>${g.title}<b>${rows.length}</b></button>
          <span class="stw-gact">${acts}</span></header>
        ${open ? `<ul class="stw-list">${rows.map(rowHtml).join('')}</ul>` : ''}</section>`;
    }).join('');
    $('stw-groups').innerHTML = html || `<p class="stw-empty">${S.compat && !S.compat.lists ? '' : (S.rows.length ? 'No containers match.' : 'No containers.')}</p>`;
  }

  function renderBar() {
    const sel = S.rows.filter((r) => S.sel.has(r.name));
    const upd = sel.filter((r) => r.can && r.verdict === 'available');
    const busy = runActive() || S.working;
    const set = (id, text, off) => { const b = $(id); b.textContent = text; b.setAttribute('aria-disabled', off ? 'true' : 'false'); };
    $('stw-clear').hidden = !sel.length; $('stw-clear').textContent = 'Clear selection (' + sel.length + ')';
    set('stw-check-sel', `Check selected${sel.length ? ` (${sel.length})` : ''}`, !sel.length || busy);
    set('stw-update-sel', `Update selected${upd.length ? ` (${upd.length})` : ''}`, !upd.length || runActive() || !updatesOk());
    set('stw-check-all', 'Check all', !S.rows.length || busy);
    set('stw-check-update', sel.length ? `Check & update (${sel.length})` : 'Check & update all', !S.rows.length || busy);
    $('stw-sort').value = S.sort.key;
    $('stw-dir').textContent = S.sort.dir > 0 ? '▲' : '▼';
  }

  function renderStatus() {
    const avail = S.rows.filter((r) => r.can && r.verdict === 'available').length;
    let t = avail ? `${avail} update${avail === 1 ? '' : 's'} available` : (S.rows.length ? 'Everything is up to date ✓' : '');
    t += S.rows.length ? ` · ${S.rows.length} containers · last full check ${ago(S.full)}` : '';
    if (S.working || S.queue.length) t += ` · checking ${Math.min(S.done + 1, S.total)} of ${S.total}`;
    $('stw-status').textContent = t;
  }

  function renderRun() {
    let h = '';
    if (S.notice) {
      h = `<div class="stw-banner"><span>${S.notice.html}</span><span class="stw-bbtns">
        ${S.notice.ok ? `<button type="button" class="stw-btn stw-main" data-act="notice-ok">${esc(S.notice.label || 'OK')}</button>` : ''}
        <button type="button" class="stw-btn" data-act="notice-no">${S.notice.ok ? 'Cancel' : 'Dismiss'}</button></span></div>`;
    } else if (S.run) {
      const its = S.run.items, done = its.filter((i) => i.state === 'done').length, same = its.filter((i) => i.state === 'unchanged').length, bad = its.filter((i) => i.state === 'failed').length;
      const fin = !!S.run.finished;
      const head = fin ? `Update finished: ${done} updated${same ? `, ${same} already current` : ''}${bad ? `, ${bad} not applied` : ''}.`
        : `Updating ${Math.min(done + same + bad + 1, its.length)} of ${its.length}. It keeps running if you leave this page.`;
      h = `<div class="stw-banner ${fin && bad ? 'bad' : ''}"><div class="stw-bhead"><b>${head}</b>
        <div class="stw-bar2"><i style="width:${Math.round((done + same + bad) / its.length * 100)}%"></i></div></div>
        <span class="stw-bbtns">${canPopup() && !S.popup ? '<button type="button" class="stw-btn" data-act="progress">Show progress</button>' : ''}${fin ? '<button type="button" class="stw-btn" data-act="run-dismiss">Dismiss</button>' : ''}</span></div>`;
    }
    $('stw-run').hidden = !h;
    $('stw-run').innerHTML = h;
  }

  function renderCompat() {
    const c = S.compat, box = $('stw-compat'), foot = $('stw-foot');
    if (!c) { box.hidden = true; return; }
    const tested = c.tested.length ? c.tested.join(', ') : 'nothing recorded';
    foot.textContent = `Docker Steward · tested on Unraid ${tested} · running ${c.unraid || 'unknown'}` + (c.level === 'untested' ? ' (this version has not been verified yet)' : '');
    let h = '';
    if (c.level === 'broken' || c.level === 'degraded') {
      h = `<div class="stw-banner bad"><div><b>${c.level === 'broken' ? 'This plugin cannot read Docker data on this Unraid version.' : 'Updating is switched off on this Unraid version.'}</b>
        <ul class="stw-problems">${c.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        <span class="stw-sub">Tested on ${esc(tested)}, running ${esc(c.unraid || 'unknown')}. Update the plugin, or run <code>docker-steward-selftest</code> on the server for details.</span></div></div>`;
    }
    box.hidden = !h; box.innerHTML = h;
  }

  function render() { renderCompat(); renderGroups(); renderBar(); renderStatus(); renderRun(); pin(); }

  /* ------------------------------------------------------------- checks */
  function enqueue(names, then) {
    if (then === 'batch') S.batch = new Set(names.filter((n) => !S.pending.has(n)));
    for (const n of names) {
      if (S.pending.has(n) || !find(n)) continue;
      S.pending.set(n, 'queued'); S.errors.delete(n);
      S.queue.push({ name: n, then });
      S.total++;
    }
    render();
    pump();
  }

  async function pump() {
    if (S.working) return;
    S.working = true;
    while (S.queue.length) {
      const job = S.queue.shift();
      S.pending.set(job.name, 'checking');
      renderGroups(); renderStatus();
      const r = await post('check.php', { name: job.name });
      S.pending.delete(job.name);
      S.done++;
      const row = find(job.name);
      if (row && r.ok) {
        row.local = r.local; row.remote = r.remote; row.checked = r.at;
        if (r.status === 'true') row.verdict = 'current';
        else if (r.status === 'false') row.verdict = 'available';
        if (job.then === 'update') {
          if (r.status === 'false') startRun([job.name]);
          else S.errors.set(job.name, 'Already up to date, nothing to update.');
        }
      } else if (row) {
        S.errors.set(job.name, r.code === 'registry' ? 'Registry did not answer; kept the previous result.' : 'Check failed (' + (r.code || 'error') + ').');
      }
      renderGroups(); renderBar(); renderStatus();
    }
    S.working = false; S.total = 0; S.done = 0;
    render();
    if (S.batch) {   // "Check & update": checks are in, now offer what is waiting (priority order)
      const names = S.batch; S.batch = null;
      const rows = S.rows.filter((r) => names.has(r.name) && r.can && r.verdict === 'available');
      if (rows.length) updateConfirm(rows);
      else { S.notice = { html: 'Checked ' + names.size + ' container' + (names.size === 1 ? '' : 's') + '. Nothing to update ✓' }; renderRun(); }
    }
  }

  /* ------------------------------------------------------ progress popup
   * update_container publishes its pull/recreate output to Unraid's 'docker'
   * nchan channel, and every webGUI page already has a subscriber (nchan_docker)
   * that renders it into <pre id="swaltext">. This opens the same kind of popup
   * the stock Docker page uses, but the run itself is driven by our worker. */
  function canPopup() { return typeof swal === 'function' && typeof nchan_docker !== 'undefined'; }

  function popupTitle() {
    const its = S.run ? S.run.items : [];
    const n = its.filter((i) => i.state !== 'queued' && i.state !== 'running').length;
    return runActive() ? `In progress (${Math.min(n + 1, its.length)} of ${its.length}) <i class="fa fa-refresh fa-spin"></i>` : 'Finished';
  }

  /* While the popup is closed, the stock renderer needs a <pre id="swaltext"> to
   * write into, or the output would be lost. A hidden holder keeps it, and its
   * content is moved into the popup when it is opened again. */
  function holder() { return document.querySelector('pre[data-hold]'); }
  function hold(html) {
    let h = holder();
    if (!h) { h = document.createElement('pre'); h.id = 'swaltext'; h.dataset.hold = '1'; h.hidden = true; $('stw').appendChild(h); }
    if (html != null) h.innerHTML = html;
  }
  function subscribe() { if (canPopup() && !S.sub) { nchan_docker.start(); S.sub = true; } }
  function unsubscribe() { if (S.sub && !S.popup) { nchan_docker.stop(); S.sub = false; } }

  function openProgress() {
    if (!canPopup() || S.popup) return;
    const h = holder(), kept = h ? h.innerHTML : '';
    if (h) h.remove();                       // two #swaltext at once would confuse the stock renderer
    S.popup = true; subscribe();
    swal({
      title: 'Updating containers - <span id="pluginProgressTitle">' + popupTitle() + '</span>',
      text: "<pre id='swaltext'></pre><hr>", html: true, animation: 'none',
      showConfirmButton: true, confirmButtonText: 'Close',
    }, function () {
      const html = S.snap;                   // kept fresh by the capture below
      S.popup = false;
      jQuery('.sweet-alert').hide('fast').removeClass('nchan stw-pop');
      if (S.run) hold(html);                 // keep collecting while closed
      if (!runActive()) setTimeout(unsubscribe, 2000);
      renderRun();
    });
    jQuery('.sweet-alert').addClass('nchan stw-pop');
    jQuery('button.confirm').prop('disabled', false);
    const box = jQuery('.sweet-alert pre#swaltext');
    if (kept) box.html(kept).scrollTop(box[0].scrollHeight);
    // remember what the popup shows, so it can be restored after Close
    clearInterval(S.snapTimer);
    S.snapTimer = setInterval(() => {
      if (!S.popup) return clearInterval(S.snapTimer);
      S.snap = jQuery('.sweet-alert pre#swaltext').html();
    }, 500);
    S.snap = kept;
  }

  function syncPopup() {
    if (S.popup) jQuery('#pluginProgressTitle').html(popupTitle());
  }

  /* ------------------------------------------------------------ updates */
  async function startRun(names) {
    const r = await post('run.php', { names });
    if (!r.ok) {
      S.notice = { html: r.code === 'busy' ? 'Another update run is already in progress.' : 'Could not start the update (' + esc(r.code || 'error') + ').' };
      render(); return;
    }
    S.run = r.run; S.notice = null; S.sel.clear();
    render(); poll(); hold(); openProgress();
  }

  function ask(html, label, ok) { S.notice = { html, label, ok }; renderRun(); $('stw-run').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  function updateConfirm(rows) {
    ask(`Update ${rows.length} container${rows.length === 1 ? '' : 's'} in this order: ${rows.map((r) => '<b>' + esc(r.name) + '</b>').join(', ')}?`,
      'Update', () => startRun(rows.map((r) => r.name)));
  }

  function poll() {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(async () => {
      let r;
      try { r = await (await fetch(BASE + 'run.php', { cache: 'no-store', credentials: 'same-origin' })).json(); } catch (e) { return poll(); }
      S.run = r.run;
      if (runActive()) { renderRun(); renderGroups(); renderBar(); syncPopup(); return poll(); }
      await load(); syncPopup(); if (!S.popup) setTimeout(unsubscribe, 2000);
    }, 1500);
  }

  /* ------------------------------------------------------------- events */
  function closeMenu() { S.menuFor = null; $('stw-menu').hidden = true; }

  function openMenu(name, btn) {
    const r = find(name); if (!r) return;
    S.menuFor = name;
    const m = $('stw-menu');
    const item = (act, label, off, hint) => `<button type="button" role="menuitem" data-act="${act}"${off ? ' aria-disabled="true"' : ''}>${label}${hint ? `<small>${hint}</small>` : ''}</button>`;
    m.innerHTML = item('m-check', 'Check for update')
      + item('m-checkupdate', 'Check and update now', !r.can, r.can ? '' : 'not updatable here')
      + item('m-force', 'Force update (re-pull)', !r.can, r.can ? 'even if already current' : 'not updatable here');
    m.hidden = false;
    const b = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(b.right - w, innerWidth - w - 8)) + 'px';
    m.style.top = (b.bottom + h + 8 > innerHeight ? Math.max(8, b.top - h - 4) : b.bottom + 4) + 'px';
  }

  const groupRows = (id) => shown().filter(GROUPS.find((g) => g.id === id).test);

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el && !e.target.closest('#stw-menu')) closeMenu();
    if (!el || disabled(el)) return;
    const act = el.dataset.act;
    const tr = el.closest('[data-name]');
    const name = tr ? tr.dataset.name : S.menuFor;

    switch (act) {
      case 'sel': el.checked ? S.sel.add(name) : S.sel.delete(name); renderGroups(); renderBar(); return;
      case 'selgroup': for (const r of groupRows(el.dataset.g)) el.checked ? S.sel.add(r.name) : S.sel.delete(r.name); renderGroups(); renderBar(); return;
      case 'fold': { const g = GROUPS.find((x) => x.id === el.dataset.g); S.open[g.id] = !isOpen(g); saveJson('stw.open', S.open); renderGroups(); return; }
      case 'check': enqueue([name]); return;
      case 'update': startRun([name]); return;
      case 'update-group': updateConfirm(groupRows('needs').sort((a, b) => a.n - b.n)); return;   // priority order, not display order
      case 'check-group': enqueue(groupRows(el.dataset.g).map((r) => r.name)); return;
      case 'menu': S.menuFor === name && !$('stw-menu').hidden ? closeMenu() : openMenu(name, el); return;
      case 'm-check': closeMenu(); enqueue([name]); return;
      case 'm-checkupdate': closeMenu(); enqueue([name], 'update'); return;
      case 'm-force':
        closeMenu();
        ask(`Force update <b>${esc(name)}</b>? The image is pulled again and the container is recreated even if it is already current.`, 'Force update', () => startRun([name]));
        return;
      case 'notice-ok': { const f = S.notice.ok; S.notice = null; renderRun(); f(); return; }
      case 'notice-no': S.notice = null; renderRun(); return;
      case 'progress': openProgress(); return;
      case 'run-dismiss': post('run.php', { dismiss: 1 }).then(() => { S.run = null; const h = holder(); if (h) h.remove(); unsubscribe(); renderGroups(); renderRun(); }); return;
    }
  });

  $('stw-clear').addEventListener('click', () => { S.sel.clear(); render(); });
  $('stw-check-all').addEventListener('click', (e) => { if (!disabled(e.currentTarget)) enqueue(S.rows.map((r) => r.name)); });
  $('stw-check-update').addEventListener('click', (e) => {
    if (disabled(e.currentTarget)) return;
    const names = S.sel.size ? S.rows.filter((r) => S.sel.has(r.name)).map((r) => r.name) : S.rows.map((r) => r.name);
    enqueue(names, 'batch');
  });
  $('stw-check-sel').addEventListener('click', (e) => { if (!disabled(e.currentTarget)) enqueue(shown().filter((r) => S.sel.has(r.name)).map((r) => r.name)); });
  $('stw-update-sel').addEventListener('click', (e) => {
    if (disabled(e.currentTarget)) return;
    const rows = S.rows.filter((r) => S.sel.has(r.name) && r.can && r.verdict === 'available');   // priority order, whatever the display sort
    if (rows.length) updateConfirm(rows);
  });
  $('stw-q').addEventListener('input', (e) => { S.q = e.target.value; renderGroups(); });
  $('stw-sort').addEventListener('change', (e) => { S.sort.key = e.target.value; saveJson('stw.sort', S.sort); renderGroups(); });
  $('stw-dir').addEventListener('click', () => { S.sort.dir *= -1; saveJson('stw.sort', S.sort); renderBar(); renderGroups(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); $('stw-q').focus(); }
  });
  addEventListener('scroll', closeMenu, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - S.loadedAt > 60000 && !S.working && !runActive()) load();
  });
  addEventListener('pageshow', render);   // bfcache restore: redraw from state, never trust restored DOM

  /* --------------------------------------------------- pinned action bar
   * position: sticky cannot work here (an ancestor scrolls horizontally), so the
   * bar switches to position: fixed under the Unraid tab bar once it would leave
   * the screen, and a same-height placeholder keeps the page from jumping. */
  let pinned = false;
  function pin() {
    const box = $('stw-barbox'), bar = $('stw-bar');
    const menu = document.getElementById('menu');
    const pos = menu ? getComputedStyle(menu).position : '';
    const off = pos === 'sticky' || pos === 'fixed' ? menu.offsetHeight : 0;
    const r = box.getBoundingClientRect();
    if (r.top < off) {
      if (!pinned) { box.style.height = box.offsetHeight + 'px'; pinned = true; bar.classList.add('pinned'); }
      bar.style.top = off + 'px'; bar.style.left = r.left + 'px'; bar.style.width = r.width + 'px';
    } else if (pinned) {
      pinned = false; bar.classList.remove('pinned'); box.style.height = '';
      bar.style.top = bar.style.left = bar.style.width = '';
    }
  }
  let raf = 0;
  addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(pin); }, { passive: true });
  addEventListener('resize', () => {
    pinned = false; $('stw-bar').classList.remove('pinned'); $('stw-barbox').style.height = '';
    closeMenu(); pin();
  });

  setInterval(() => { if (!document.hidden) { renderGroups(); renderStatus(); } }, 30000);   // keeps "x min ago" honest
  load();
})();
