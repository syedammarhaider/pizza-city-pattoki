'use strict';
/*
 * Pizza City POS - Frontend
 * Developer: Syed Ammar Haider | 03214499478
 * Place this file at: public/app.js
 */
(function () {
  /* ---------- helpers ---------- */
  const $ = id => document.getElementById(id);
  const qsa = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const dstr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => dstr(new Date());
  const SIZES = ['S', 'M', 'L'];
  const TYPE_LABEL = { delivery: 'Home Delivery', takeaway: 'Takeaway', dinein: 'Dine-in' };
  const PAY_LABEL = { cash: 'Cash', online: 'Online', card: 'Card' };
  const PROTECTED = ['dash', 'menu-mgr', 'settings'];
  const LOCK_MS = 3 * 60 * 1000;     // admin area locks after 3 minutes without use

  const S = {
    settings: { toppingPrices: { S: 0, M: 0, L: 0 }, phones: [], deliveryFee: 0, receiptWidth: 80, autoPrint: true,
      showTagline: true, showAddress: true, showPhones: true, showFooter: true },
    menu: { categories: [], items: [] },
    credit: { name: 'Ammar', phone: '03214499478' },
    token: '',
    lastAct: 0,
    type: 'delivery',
    pay: 'cash',
    cat: '',
    mmCat: '__all',
    cart: [],
    todayCount: 0,
    todaySum: 0,
    known: new Map(),
    view: 'counter',
    width: 80,
    editingId: null,
    viewId: null,
    miType: 'sized',
    loaded: false,
    wasOffline: false,
    loginResolve: null,
    loginPending: null
  };

  const nf = n => Number(n || 0).toLocaleString('en-US');
  const money = n => 'Rs. ' + nf(n);

  let toastTimer = null;
  function toast(msg, err) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!err);
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), err ? 4000 : 2200);
  }

  /* ---------- admin session / auto-lock ---------- */
  function persistSession() {
    try {
      if (S.token) { sessionStorage.setItem('pc_token', S.token); sessionStorage.setItem('pc_act', String(S.lastAct)); }
      else { sessionStorage.removeItem('pc_token'); sessionStorage.removeItem('pc_act'); }
    } catch (e) {}
  }
  function setToken(t) {
    S.token = t || '';
    if (S.token) S.lastAct = Date.now();
    persistSession();
    updateLockUI();
    renderToday();
  }
  function touch() {
    if (S.token && PROTECTED.indexOf(S.view) >= 0) S.lastAct = Date.now();
  }
  function fmtLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + pad(s % 60);
  }
  function updateLockUI() {
    const open = !!S.token;
    document.body.classList.toggle('is-locked', !open);
    $('lockBtn').dataset.s = open ? 'open' : 'locked';
    $('lockTxt').textContent = open ? fmtLeft(LOCK_MS - (Date.now() - S.lastAct)) : 'Locked';
    $('lockBtn').title = open ? 'Click to lock now' : 'Click to unlock';
  }
  function wipeProtected() {
    ['kpis', 'monthKpis', 'dashOrders', 'mmList', 'mmCatTabs'].forEach(id => { $(id).innerHTML = ''; });
    $('dashDate').textContent = '';
    $('backupInfo').textContent = '';
    qsa('#v-settings input, #v-settings textarea').forEach(i => {
      if (i.type === 'checkbox') i.checked = false; else i.value = '';
    });
  }
  function lockNow(auto) {
    const t = S.token;
    if (t) { try { fetch('/api/logout', { method: 'POST', headers: { 'x-auth-token': t } }).catch(() => {}); } catch (e) {} }
    setToken('');
    wipeProtected();
    closeModal();
    if (PROTECTED.indexOf(S.view) >= 0) showViewRaw('counter');
    if (t) toast(auto ? 'Admin area locked (3 minutes passed)' : 'Admin area locked');
  }
  function lockTick() {
    if (!S.token) return;
    const left = LOCK_MS - (Date.now() - S.lastAct);
    if (left <= 0) { lockNow(true); return; }
    updateLockUI();
    persistSession();
  }

  /* ---------- status / connection ---------- */
  function setStatus(ok) {
    $('statusBtn').dataset.s = ok ? 'ok' : 'error';
    $('statusTxt').textContent = ok ? 'Online' : 'Offline';
    $('offlineBanner').classList.toggle('hide', ok);
    if (ok && (!S.loaded || S.wasOffline)) {
      S.wasOffline = false;
      loadState().then(refreshToday).catch(() => {});
    }
    if (!ok) S.wasOffline = true;
  }
  async function ping() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      await r.json();
      setStatus(true);
    } catch (e) { setStatus(false); }
  }

  /* ---------- API ---------- */
  async function api(method, url, body, retried) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (S.token) headers['x-auth-token'] = S.token;
    let res;
    try {
      res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      setStatus(false);
      throw new Error('Server not reachable. Run start.bat');
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && !retried) {
      setToken('');
      const ok = await askLogin();
      if (ok) return api(method, url, body, true);
      throw new Error('Password required');
    }
    if (!res.ok) throw new Error(data.error || ('Error ' + res.status));
    return data;
  }

  /* ---------- login ---------- */
  function askLogin() {
    if (S.loginPending) return S.loginPending;
    S.loginPending = new Promise(resolve => { S.loginResolve = resolve; });
    $('pinInput').value = '';
    $('pinInput').type = 'password';
    $('pinErr').textContent = '';
    $('loginOverlay').style.display = 'grid';
    setTimeout(() => $('pinInput').focus(), 50);
    return S.loginPending;
  }
  function closeLogin(ok) {
    $('loginOverlay').style.display = 'none';
    $('pinInput').value = '';
    const r = S.loginResolve;
    S.loginResolve = null;
    S.loginPending = null;
    if (r) r(ok);
  }
  async function submitPin() {
    const password = $('pinInput').value;
    if (!password) { $('pinErr').textContent = 'Enter the password'; return; }
    $('pinErr').textContent = '';
    $('pinSubmit').disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { $('pinErr').textContent = d.error || 'Wrong password'; $('pinInput').value = ''; $('pinInput').focus(); return; }
      setToken(d.token);
      closeLogin(true);
    } catch (e) {
      $('pinErr').textContent = 'Server not reachable';
    } finally { $('pinSubmit').disabled = false; }
  }

  /* ---------- state ---------- */
  async function loadState() {
    const d = await api('GET', '/api/state');
    S.settings = d.settings;
    S.menu = d.menu;
    if (d.credit) S.credit = d.credit;
    if (S.token && !d.authed) setToken('');
    S.width = S.settings.receiptWidth === 58 ? 58 : 80;
    S.loaded = true;
    applySettings();
    renderCats();
    renderMenu();
    renderDrinks();
    if ($('iDelivery').value === '0' || $('iDelivery').value === '') {
      $('iDelivery').value = S.type === 'delivery' ? (S.settings.deliveryFee || 0) : 0;
    }
    renderCart();
  }

  function applySettings() {
    const s = S.settings;
    $('shopHeading').textContent = String(s.shopName || 'Pizza City').toUpperCase();
    const tag = s.showTagline !== false ? (s.tagline || '') : '';
    $('shopTagline').textContent = tag;
    $('shopTagline').classList.toggle('hide', !tag);
    document.title = (s.shopName || 'Pizza City') + ' – POS';
  }

  /* ---------- theme ---------- */
  function applyTheme(t) {
    document.documentElement.classList.toggle('light', t === 'light');
    try { localStorage.setItem('pc_theme', t); } catch (e) {}
    setSeg('segTheme', t);
  }
  function setSeg(id, v) {
    qsa('button', $(id)).forEach(b => b.classList.toggle('on', b.dataset.v === v));
  }
  function bindSeg(id, cb) {
    $(id).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || !$(id).contains(b)) return;
      setSeg(id, b.dataset.v);
      cb(b.dataset.v);
    });
  }

  /* ---------- counter: menu ---------- */
  function visibleCats() {
    return (S.menu.categories || []).filter(c => c !== 'Drinks' && S.menu.items.some(i => i.category === c && i.active));
  }
  function renderCats() {
    const cats = visibleCats();
    if (cats.indexOf(S.cat) < 0) S.cat = cats[0] || '';
    $('catTabs').innerHTML = cats.map(c =>
      '<button class="cat-btn' + (c === S.cat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('');
  }
  function cardHTML(it) {
    const isDeal = it.category === 'Deals';
    let h = '<div class="menu-card' + (isDeal ? ' deal-card' : '') + '" data-id="' + esc(it.id) + '">';
    if (isDeal) h += '<div class="dl-top"><div class="mc-name">' + esc(it.name) + '</div><span class="dl-pill">DEAL</span></div>';
    else h += '<div class="mc-name">' + esc(it.name) + '</div>';
    if (it.description) {
      if (isDeal) {
        h += '<ul class="dl-list">' + String(it.description).split('\n').filter(x => x.trim())
          .map(x => '<li>' + esc(x.trim()) + '</li>').join('') + '</ul>';
      } else h += '<div class="mc-desc">' + esc(it.description) + '</div>';
    }
    if (it.type === 'single') {
      h += '<div class="mc-single-price">' + esc(money(it.price)) + '</div>';
    } else {
      h += '<div class="mc-prices">';
      SIZES.forEach(sz => {
        if (it.prices[sz] > 0) h += '<span class="mc-sz" data-size="' + sz + '">' + sz + ' · ' + esc(money(it.prices[sz])) + '</span>';
      });
      h += '</div>';
    }
    return h + '</div>';
  }
  function renderDealBanner() {
    const bn = $('dealBanner');
    const on = S.cat === 'Deals';
    bn.classList.toggle('hide', !on);
    if (on) bn.innerHTML = '<span class="dl-hot">HOT DEALS</span>';
  }
  function renderMenu() {
    const list = S.menu.items.filter(i => i.category === S.cat && i.active);
    $('menuGrid').innerHTML = list.length ? list.map(cardHTML).join('') : '<div class="empty-cart">No items in this category</div>';
    renderDealBanner();
  }
  function renderDrinks() {
    const list = S.menu.items.filter(i => i.category === 'Drinks' && i.active);
    let h = '';
    list.forEach(it => {
      if (it.type === 'single') {
        h += '<button class="drink-btn" data-id="' + esc(it.id) + '" data-size=""><span class="db-size">' + esc(it.name) + '</span><span class="db-price">' + esc(money(it.price)) + '</span></button>';
      } else {
        SIZES.forEach(sz => {
          if (it.prices[sz] > 0) h += '<button class="drink-btn" data-id="' + esc(it.id) + '" data-size="' + sz + '"><span class="db-size">' + esc(it.name) + ' (' + sz + ')</span><span class="db-price">' + esc(money(it.prices[sz])) + '</span></button>';
        });
      }
    });
    $('drinksGrid').innerHTML = h || '<div class="empty-cart">No drinks</div>';
  }

  /* ---------- counter: cart ---------- */
  function addToCart(id, size) {
    const it = S.menu.items.find(x => x.id === id);
    if (!it || !it.active) return;
    if (it.type === 'sized' && !(it.prices[size] > 0)) return;
    const sz = it.type === 'sized' ? size : '';
    const ex = S.cart.find(l => l.itemId === id && l.size === sz);
    if (ex) { if (ex.qty < 999) ex.qty++; }
    else S.cart.push({ itemId: id, size: sz, qty: 1, toppings: 0 });
    renderCart();
  }

  function calc() {
    const s = S.settings;
    S.cart = S.cart.filter(l => S.menu.items.some(x => x.id === l.itemId));
    const lines = [];
    let sub = 0;
    S.cart.forEach((l, idx) => {
      const it = S.menu.items.find(x => x.id === l.itemId);
      const unit = it.type === 'sized' ? (it.prices[l.size] || 0) : it.price;
      const allow = it.type === 'sized' && it.allowToppings;
      const topUnit = allow ? ((s.toppingPrices || {})[l.size] || 0) : 0;
      const total = (unit + l.toppings * topUnit) * l.qty;
      lines.push({ idx, itemId: it.id, name: it.name, size: l.size, qty: l.qty, unit, toppings: l.toppings, toppingUnit: topUnit, allow, note: '', description: it.description || '', total });
      sub += total;
    });
    let disc = Math.round(Number($('iDiscount').value) || 0);
    if (disc < 0) disc = 0;
    if (disc > sub) disc = sub;
    const isDel = S.type === 'delivery';
    const fee = isDel ? Math.max(0, Math.round(Number($('iDelivery').value) || 0)) : 0;
    const total = sub - disc + fee;
    return { lines, subtotal: sub, discount: disc, fee, total };
  }

  function renderCart() {
    const c = calc();
    if (!c.lines.length) {
      $('cartTable').innerHTML = '<thead><tr><th>Item</th><th>Quantity</th><th>Amount</th><th></th></tr></thead>' +
        '<tbody><tr><td colspan="4" class="empty-cart">No items yet</td></tr></tbody>';
    } else {
      $('cartTable').innerHTML = '<thead><tr><th>Item</th><th>Quantity</th><th>Amount</th><th></th></tr></thead><tbody>' + c.lines.map(l => {
        let h = '<tr data-i="' + l.idx + '"><td><div class="cart-item-name">' + esc(l.name) + '</div>';
        if (l.size) h += '<div class="cart-size">Size ' + esc(l.size) + ' · ' + esc(money(l.unit)) + '</div>';
        else h += '<div class="cart-size">' + esc(money(l.unit)) + '</div>';
        if (l.description) h += '<div class="mc-desc" style="white-space:pre-line">' + esc(l.description) + '</div>';
        if (l.allow) {
          h += '<div class="top-row"><span class="tl">Extra topping</span>' +
            (l.toppingUnit > 0 ? '<span class="tc">+' + esc(money(l.toppingUnit)) + ' each</span>' : '') +
            '<div class="qty-ctrl"><button data-act="tdec">−</button><span>' + l.toppings + '</span><button data-act="tinc">+</button></div>' +
            (l.toppings > 0 && l.toppingUnit > 0 ? '<span class="ts">= ' + esc(money(l.toppings * l.toppingUnit * l.qty)) + '</span>' : '') + '</div>';
        }
        h += '</td><td><div class="qty-ctrl"><button data-act="dec">−</button><span>' + l.qty + '</span><button data-act="inc">+</button></div></td>' +
          '<td style="text-align:right;font-weight:700;white-space:nowrap">' + esc(money(l.total)) + '</td>' +
          '<td><button class="del-btn" data-act="del" title="Remove">×</button></td></tr>';
        return h;
      }).join('') + '</tbody>';
    }
    renderTotals(c);
  }

  let previewQueued = false;
  function renderTotals(c) {
    c = c || calc();
    $('tSub').textContent = money(c.subtotal);
    $('tDisc').textContent = '– ' + money(c.discount);
    $('tDiscRow').style.display = c.discount > 0 ? '' : 'none';
    $('tDelRow').style.display = S.type === 'delivery' ? '' : 'none';
    $('tDel').textContent = c.fee === 0 ? 'FREE' : money(c.fee);
    $('tTotal').textContent = money(c.total);
    if (!previewQueued) {
      previewQueued = true;
      requestAnimationFrame(() => { previewQueued = false; renderPreview(calc()); });
    }
  }

  function pseudoOrder(c) {
    const recv = S.pay === 'cash' ? Math.round(Number($('iCashRecv').value) || 0) : 0;
    return {
      no: '—', dayNo: '—', createdAt: new Date().toISOString(),
      type: S.type, table: $('cTable').value.trim(),
      customer: { name: $('cName').value.trim(), phone: $('cPhone').value.trim(), address: $('cAddr').value.trim() },
      items: c.lines,
      subtotal: c.subtotal, discount: { amount: c.discount },
      deliveryFee: c.fee, total: c.total,
      payment: { method: S.pay, received: recv, change: recv >= c.total ? recv - c.total : 0 },
      note: $('iNote').value.trim(), status: 'completed'
    };
  }
  function renderPreview(c) {
    if (!c.lines.length) {
      $('rcptPreview').innerHTML = '<div class="empty-cart">Add items to see the receipt</div>';
      return;
    }
    $('rcptPreview').innerHTML = receiptHTML(pseudoOrder(c), false);
  }

  /* ---------- receipt ---------- */
  function barsSVG(seed) {
    const s = String(seed);
    let r = 7;
    for (let i = 0; i < s.length; i++) r = (r * 31 + s.charCodeAt(i)) >>> 0;
    let x = 0, rects = '', k = 0;
    const put = w => { rects += '<rect x="' + x + '" y="0" width="' + w + '" height="30" style="animation-delay:' + (k * 0.014).toFixed(3) + 's"/>'; k++; x += w; };
    const gap = w => { x += w; };
    // start guard
    put(2); gap(1); put(1); gap(1);
    for (let i = 0; i < 46; i++) {
      r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
      const w = 1 + (r >>> 29) % 3;
      if (i % 2 === 0) put(w); else gap(w);
    }
    // end guard
    gap(1); put(1); gap(1); put(2);
    return '<svg class="rc-bars" viewBox="0 0 ' + x + ' 30" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#777" aria-hidden="true">' + rects + '</svg>';
  }
  const MARK = '<svg class="rc-mark" viewBox="0 0 32 32" fill="none" stroke="#777" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 9c8-6 16-6 24 0L16 29z"/><circle cx="12" cy="12.5" r="1.8" fill="#777" stroke="none"/>' +
    '<circle cx="19" cy="12" r="1.8" fill="#777" stroke="none"/><circle cx="15.5" cy="19" r="1.8" fill="#777" stroke="none"/></svg>';

  function kv(l, r) { return '<div class="rc-kv"><span>' + esc(l) + '</span><b>' + esc(r) + '</b></div>'; }
  function sumLine(l, r) { return '<div class="rc-kv"><span>' + esc(l) + '</span><span>' + esc(r) + '</span></div>'; }

  function receiptHTML(o, forPrint) {
    const s = S.settings;
    const narrow = s.receiptWidth === 58;
    const d = new Date(o.createdAt);
    const dateTxt = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeTxt = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const style = forPrint
      ? ' style="width:' + (narrow ? '54mm' : '76mm') + '"'
      : ' style="max-width:' + (narrow ? '250px' : '330px') + '"';
    let h = '<div class="rc' + (narrow ? ' rc-58' : '') + (forPrint ? '' : ' rc-screen') + '"' + style + '>';

    // Header
    h += '<div class="rc-head">' + MARK + '<div class="rc-shop">' + esc(s.shopName || '') + '</div>';
    if (s.showTagline !== false && s.tagline) h += '<div class="rc-tag">' + esc(s.tagline) + '</div>';
    if (s.showAddress !== false && s.address) h += '<div class="rc-sub">' + esc(s.address) + '</div>';
    if (s.showPhones !== false && (s.phones || []).length) h += '<div class="rc-sub rc-tel"><b>Tel:</b> ' + esc(s.phones.map(p => String(p).replace(/\D/g, '')).join(', ')) + '</div>';
    h += '</div><hr class="rc-dbl">';

    // Token + order info
    h += '<div class="rc-top"><div class="rc-token"><small>TOKEN</small><b>' + esc(o.dayNo) + '</b></div>' +
      '<div class="rc-meta"><div><span>ORDER</span><b>#' + esc(o.no) + '</b></div>' +
      '<div><span>DATE</span><b>' + esc(dateTxt) + '</b></div>' +
      '<div><span>TIME</span><b>' + esc(timeTxt) + '</b></div></div></div>';

    const typeTxt = (TYPE_LABEL[o.type] || o.type).toUpperCase();
    h += '<div class="rc-type"><span>' + esc(typeTxt) + '</span></div>';

    // Customer
    const cu = o.customer || {};
    let rows = '';
    if (o.type === 'dinein' && o.table) rows += kv('Table', o.table);
    if (cu.name) rows += kv('Name', cu.name);
    if (cu.phone) rows += kv('Mobile', cu.phone);
    if (o.type === 'delivery' && cu.address) rows += '<div class="rc-kv rc-addr"><span>Address</span><b>' + esc(cu.address) + '</b></div>';
    if (rows) h += '<div class="rc-box">' + rows + '</div>';

    // Items: ITEM | QTY | AMOUNT
    h += '<div class="rc-th"><span>ITEM</span><span>QTY</span><span>AMOUNT</span></div>';
    (o.items || []).forEach(i => {
      h += '<div class="rc-it"><div class="rc-row"><span class="rc-it-name">' + esc(i.name) +
        (i.size ? '<i class="rc-sz">' + esc(i.size) + '</i>' : '') + '</span><span class="q">' + esc(i.qty) + '</span><b class="a">' + nf(i.total) + '</b></div>';
      h += '<div class="rc-it-sub rc-unit">' + esc(money(i.unit)) + ' each</div>';
      const dealItem = i.description || ((S.menu.items || []).find(m => m.id === i.itemId) || {}).description || '';
      String(dealItem).split('\n').filter(x => x.trim()).forEach(line => {
        h += '<div class="rc-it-sub rc-dl">' + esc(line.trim()) + '</div>';
      });
      if (i.toppings > 0) {
        const tu = Number(i.toppingUnit) || 0;
        h += '<div class="rc-it-sub rc-tp">+ ' + i.toppings + ' extra topping' + (i.toppings > 1 ? 's' : '') +
          (tu > 0 ? ' @ ' + esc(money(tu)) + (i.qty > 1 ? ' × ' + i.qty : '') + ' = ' + esc(money(i.toppings * tu * i.qty)) : '') + '</div>';
      }
      if (i.note) h += '<div class="rc-it-sub">Note: ' + esc(i.note) + '</div>';
      h += '</div>';
    });

    // Totals
    h += '<hr class="rc-dash"><div class="rc-sum">' + sumLine('Subtotal', money(o.subtotal));
    if (o.discount && o.discount.amount > 0) h += sumLine('Discount', '- ' + money(o.discount.amount));
    if (o.type === 'delivery') h += sumLine('Delivery Fee', o.deliveryFee === 0 ? 'FREE' : money(o.deliveryFee));
    h += '</div>';
    h += '<div class="rc-total"><span>TOTAL</span><b>' + esc(money(o.total)) + '</b></div>';
    const p = o.payment || {};
    h += '<div class="rc-kv rc-payrow"><span>Payment</span><span class="rc-pay">' + esc((PAY_LABEL[p.method] || p.method || '').toUpperCase()) + '</span></div>';
    if (p.method === 'cash' && p.received > 0) {
      h += sumLine('Received', money(p.received));
      if (p.received >= o.total) h += sumLine('Change', money(p.change));
    }
    if (o.status === 'void') h += '<div class="rc-cancel">CANCELLED</div>';

    // Footer
    h += '<div class="rc-cut">✂</div>';
    if (s.showFooter !== false && s.receiptFooter) h += '<div class="rc-thanks">' + esc(s.receiptFooter) + '</div>';
    const real = /^\d+$/.test(String(o.no));
    const ymd = String(o.date || dstr(d)).replace(/-/g, '');
    const code = real ? 'PC-' + ymd + '-' + String(o.no).padStart(4, '0') : 'PC-NEW-ORDER';
    h += '<div class="rc-bc"><span class="rc-scan"></span>' + barsSVG(code + (o.dayNo || '')) +
      '<div class="rc-bc-num">' + esc(code) + '</div></div>';
    h += '<div class="rc-cr">SOFTWARE BY <b>' + esc(String(S.credit.name)) + '</b><span> · ' + esc(S.credit.phone) + '</span></div>';
    return h + '</div>';
  }
  function printReceipt(o) {
    $('printArea').innerHTML = receiptHTML(o, true);
    setTimeout(() => window.print(), 80);
  }

  /* ---------- counter: type / save ---------- */
  function setType(t) {
    S.type = t;
    setSeg('segType', t);
    const del = t === 'delivery';
    $('addrWrap').style.display = del ? '' : 'none';
    $('delivFeeWrap').style.display = del ? '' : 'none';
    $('tableWrap').style.display = t === 'dinein' ? '' : 'none';
    $('cPhoneLabel').innerHTML = del ? 'Mobile Number <span style="color:var(--red)">*</span>' : 'Mobile Number (optional)';
    if (del && (Number($('iDelivery').value) || 0) === 0) $('iDelivery').value = S.settings.deliveryFee || 0;
    renderCart();
  }
  function setPay(p) {
    S.pay = p;
    setSeg('segPay', p);
    $('cashRecvWrap').style.display = p === 'cash' ? '' : 'none';
    renderTotals();
  }
  function clearOrder() {
    S.cart = [];
    ['cName', 'cPhone', 'cAddr', 'cTable', 'iCashRecv', 'iNote'].forEach(id => { $(id).value = ''; });
    $('iDiscount').value = 0;
    $('iDelivery').value = S.type === 'delivery' ? (S.settings.deliveryFee || 0) : 0;
    renderCart();
  }

  async function saveOrder(print) {
    if (!S.cart.length) return toast('Add at least one item', true);
    const phone = $('cPhone').value.trim();
    if (S.type === 'delivery' && phone.replace(/\D/g, '').length < 7) {
      $('cPhone').focus();
      return toast('Mobile number is required for delivery', true);
    }
    const c = calc();
    const body = {
      type: S.type,
      table: $('cTable').value.trim(),
      customerName: $('cName').value.trim(),
      customerPhone: phone,
      customerAddress: S.type === 'delivery' ? $('cAddr').value.trim() : '',
      items: S.cart.map(l => ({ itemId: l.itemId, size: l.size, qty: l.qty, toppings: l.toppings })),
      discount: { type: 'amount', value: c.discount },
      deliveryFee: S.type === 'delivery' ? $('iDelivery').value : 0,
      paymentMethod: S.pay,
      cashReceived: S.pay === 'cash' ? $('iCashRecv').value : '',
      note: $('iNote').value.trim()
    };
    const b1 = $('btnPrint'), b2 = $('btnSaveOnly');
    b1.disabled = b2.disabled = true;
    try {
      const o = await api('POST', '/api/orders', body);
      S.known.set(o.id, o);
      toast('Order #' + o.no + ' saved');
      clearOrder();
      refreshToday();
      if (print && (S.settings.autoPrint || confirm('Print receipt?'))) printReceipt(o);
    } catch (e) {
      toast(e.message, true);
    } finally {
      b1.disabled = b2.disabled = false;
    }
  }

  /* ---------- today's orders ---------- */
  function renderToday() {
    $('todayN').textContent = S.todayCount;
    $('todayAmt').textContent = S.token ? money(S.todaySum) : 'Rs. ••••';
  }
  async function refreshToday() {
    try {
      const t = today();
      const d = await api('GET', '/api/orders?from=' + t + '&to=' + t);
      const ok = d.orders.filter(o => o.status === 'completed');
      S.todayCount = ok.length;
      S.todaySum = ok.reduce((a, o) => a + o.total, 0);
      renderToday();
      $('recentHd').textContent = d.orders.length + ' orders';
      d.orders.forEach(o => S.known.set(o.id, o));
      $('recentList').innerHTML = d.orders.length ? d.orders.slice(0, 40).map(o => {
        const tm = new Date(o.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const v = o.status === 'void';
        return '<div class="mm-item"><div><b>#' + o.no + ' <span class="tag ' + (v ? 'void' : o.type) + '">' + (v ? 'Cancelled' : esc(TYPE_LABEL[o.type] || o.type)) + '</span></b><br>' +
          '<span>' + tm + ' · Token ' + o.dayNo + (o.customer.phone ? ' · ' + esc(o.customer.phone) : '') + '</span></div>' +
          '<div style="text-align:right"><b' + (v ? ' style="text-decoration:line-through"' : '') + '>' + esc(money(o.total)) + '</b><br>' +
          '<button class="btn o sm" data-act="view" data-id="' + esc(o.id) + '">View</button> ' +
          '<button class="btn o sm" data-act="print" data-id="' + esc(o.id) + '">Print</button></div></div>';
      }).join('') : '<div class="empty-cart">No orders yet today</div>';
    } catch (e) { /* offline banner already shows */ }
  }

  /* ---------- order tables (dashboard / history) ---------- */
  function renderOrderTable(el, list) {
    list.forEach(o => S.known.set(o.id, o));
    let h = '<thead><tr><th>#</th><th>Time</th><th>Type</th><th>Customer</th><th>Items</th><th>Total</th><th>Pay</th><th></th></tr></thead><tbody>';
    if (!list.length) h += '<tr><td colspan="8" class="empty-cart">No orders found</td></tr>';
    list.forEach(o => {
      const d = new Date(o.createdAt);
      const when = o.date + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const items = o.items.map(i => i.qty + '× ' + i.name + (i.size ? ' (' + i.size + ')' : '')).join(', ');
      const v = o.status === 'void';
      h += '<tr' + (v ? ' style="opacity:.6"' : '') + '><td><b>#' + o.no + '</b><br><span class="tag">T' + o.dayNo + '</span></td>' +
        '<td>' + esc(when) + '</td>' +
        '<td><span class="tag ' + (v ? 'void' : o.type) + '">' + (v ? 'Cancelled' : esc(TYPE_LABEL[o.type] || o.type)) + '</span></td>' +
        '<td>' + esc(o.customer.name) + (o.customer.phone ? '<br>' + esc(o.customer.phone) : '') + '</td>' +
        '<td style="max-width:280px">' + esc(items) + (v && o.voidReason ? '<br><i>Reason: ' + esc(o.voidReason) + '</i>' : '') + '</td>' +
        '<td' + (v ? ' style="text-decoration:line-through"' : '') + '><b>' + esc(money(o.total)) + '</b></td>' +
        '<td>' + esc(PAY_LABEL[o.payment.method] || o.payment.method) + '</td>' +
        '<td style="white-space:nowrap"><button class="btn o sm" data-act="view" data-id="' + esc(o.id) + '">View</button> ' +
        '<button class="btn o sm" data-act="print" data-id="' + esc(o.id) + '">Print</button> ' +
        (v ? '' : '<button class="btn dn sm" data-act="cancel" data-id="' + esc(o.id) + '">Cancel</button>') + '</td></tr>';
    });
    el.innerHTML = h + '</tbody>';
  }

  async function cancelOrder(o) {
    if (!S.token) {
      const ok = await askLogin();
      if (!ok) return false;
    }
    const reason = prompt('Cancel order #' + o.no + '?\nReason (optional):', '');
    if (reason === null) return false;
    try {
      await api('POST', '/api/orders/' + o.id + '/cancel', { reason });
      touch();
      toast('Order #' + o.no + ' cancelled');
      refreshAfterChange();
      return true;
    } catch (er) { toast(er.message, true); return false; }
  }
  async function orderAction(e) {
    const b = e.target.closest('button[data-act]');
    if (!b || !b.dataset.id) return;
    const o = S.known.get(b.dataset.id);
    if (!o) return;
    const a = b.dataset.act;
    if (a === 'print') return printReceipt(o);
    if (a === 'view') return openOrder(o);
    if (a === 'cancel') return cancelOrder(o);
  }
  function refreshAfterChange() {
    refreshToday();
    if (S.view === 'dash') loadDash();
    if (S.view === 'hist') loadHist();
  }

  /* ---------- view a saved order ---------- */
  function openOrder(o) {
    S.viewId = o.id;
    $('omTitle').textContent = 'Order #' + o.no + ' · Token ' + o.dayNo + (o.status === 'void' ? ' · Cancelled' : '');
    $('omBody').innerHTML = receiptHTML(o, false);
    $('omCancelOrder').classList.toggle('hide', o.status === 'void');
    $('orderModal').style.display = 'grid';
  }
  function closeOrder() {
    $('orderModal').style.display = 'none';
    S.viewId = null;
  }

  /* ---------- dashboard ---------- */
  function kpi(label, value, small) {
    return '<div class="kpi"><small>' + esc(label) + '</small><b' + (small ? ' style="font-size:16px"' : '') + '>' + esc(value) + '</b></div>';
  }
  async function loadDash() {
    const t = today();
    try {
      const [r, m, o] = await Promise.all([
        api('GET', '/api/report?from=' + t + '&to=' + t),
        api('GET', '/api/report?from=' + t.slice(0, 8) + '01&to=' + t),
        api('GET', '/api/orders?from=' + t + '&to=' + t)
      ]);
      if (!S.token || S.view !== 'dash') return;
      $('dashDate').textContent = t;
      const bp = r.byPayment || {}, bt = r.byType || {};
      $('kpis').innerHTML =
        kpi('Orders', r.orders) + kpi('Sales', money(r.total)) + kpi('Average order', money(r.avg)) +
        kpi('Cash', money((bp.cash || {}).total || 0)) + kpi('Online', money((bp.online || {}).total || 0)) +
        kpi('Delivery orders', (bt.delivery || {}).count || 0) + kpi('Discounts', money(r.discounts)) + kpi('Cancelled', r.cancelled != null ? r.cancelled : r.voided);
      $('monthKpis').innerHTML =
        kpi('Orders', m.orders) + kpi('Sales', money(m.total)) + kpi('Average order', money(m.avg)) +
        kpi('Discounts', money(m.discounts)) + kpi('Top item', m.top[0] ? m.top[0].name + ' ×' + m.top[0].qty : '—', true);
      renderOrderTable($('dashOrders'), o.orders);
    } catch (e) {
      if (e.message === 'Password required') { showViewRaw('counter'); return; }
      toast(e.message, true);
    }
  }

  /* ---------- history ---------- */
  async function loadHist() {
    const from = $('hFrom').value, to = $('hTo').value;
    if (!from || !to) return toast('Choose From and To dates', true);
    try {
      const d = await api('GET', '/api/orders?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&q=' + encodeURIComponent($('hq').value.trim()));
      const type = $('hType').value;
      renderOrderTable($('histTable'), type ? d.orders.filter(o => o.type === type) : d.orders);
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- menu manager ---------- */
  function priceText(it) {
    if (it.type === 'single') return money(it.price);
    return SIZES.filter(s => it.prices[s] > 0).map(s => s + ' ' + nf(it.prices[s])).join(' / ');
  }
  function renderMM() {
    if (!S.token) return;
    const cats = S.menu.categories || [];
    $('mmCatTabs').innerHTML = '<button class="cat-btn' + (S.mmCat === '__all' ? ' on' : '') + '" data-cat="__all">All</button>' +
      cats.map(c => '<button class="cat-btn' + (c === S.mmCat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('');
    const list = S.menu.items.filter(i => S.mmCat === '__all' || i.category === S.mmCat);
    $('mmList').innerHTML = list.length ? list.map(it =>
      '<div class="mm-item"><div><b>' + esc(it.name) + '</b> ' + (it.active ? '' : '<span class="tag void">Hidden</span>') +
      '<br><span>' + esc(it.category) + ' · ' + esc(priceText(it)) + '</span></div>' +
      '<div style="white-space:nowrap"><button class="btn o sm" data-act="edit" data-id="' + esc(it.id) + '">Edit</button> ' +
      '<button class="btn o sm" data-act="toggle" data-id="' + esc(it.id) + '">' + (it.active ? 'Hide' : 'Show') + '</button> ' +
      '<button class="btn dn sm" data-act="del" data-id="' + esc(it.id) + '">Delete</button></div></div>').join('')
      : '<div class="empty-cart">No items</div>';
  }
  function menuChanged(menu) {
    S.menu = menu;
    renderCats(); renderMenu(); renderDrinks(); renderMM(); renderCart();
  }
  function itemBody(it, over) {
    return Object.assign({
      name: it.name, category: it.category, type: it.type,
      prices: it.prices, price: it.price, description: it.description,
      allowToppings: it.allowToppings, active: it.active
    }, over || {});
  }
  async function mmAction(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const it = S.menu.items.find(x => x.id === b.dataset.id);
    if (!it) return;
    try {
      if (b.dataset.act === 'edit') return openModal(it);
      if (b.dataset.act === 'toggle') {
        const d = await api('PUT', '/api/menu/items/' + it.id, itemBody(it, { active: !it.active }));
        menuChanged(d.menu);
      }
      if (b.dataset.act === 'del') {
        if (!confirm('Delete "' + it.name + '" from the menu?\nOld orders are not affected.')) return;
        const d = await api('DELETE', '/api/menu/items/' + it.id);
        menuChanged(d.menu);
        toast('Item deleted');
      }
    } catch (er) { toast(er.message, true); }
  }

  function setMiType(t) {
    S.miType = t;
    setSeg('miTypeSeg', t);
    $('miPricesSized').classList.toggle('hide', t !== 'sized');
    $('miPriceSingle').classList.toggle('hide', t !== 'single');
    $('miToppingWrap').classList.toggle('hide', t !== 'sized');
  }
  function openModal(it) {
    S.editingId = it ? it.id : null;
    $('modalTitle').textContent = it ? 'Edit Item' : 'Add Item';
    $('modalErr').textContent = '';
    $('miName').value = it ? it.name : '';
    $('miCat').value = it ? it.category : (S.mmCat !== '__all' ? S.mmCat : '');
    $('catList').innerHTML = (S.menu.categories || []).map(c => '<option value="' + esc(c) + '">').join('');
    $('miPS').value = it && it.prices.S ? it.prices.S : '';
    $('miPM').value = it && it.prices.M ? it.prices.M : '';
    $('miPL').value = it && it.prices.L ? it.prices.L : '';
    $('miPFixed').value = it && it.type === 'single' ? it.price : '';
    $('miDesc').value = it ? it.description : '';
    $('miToppings').checked = it ? !!it.allowToppings : true;
    $('miActive').checked = it ? !!it.active : true;
    setMiType(it ? it.type : 'sized');
    $('itemModal').style.display = 'grid';
    setTimeout(() => $('miName').focus(), 50);
  }
  function closeModal() { $('itemModal').style.display = 'none'; }
  async function saveModal() {
    const body = {
      name: $('miName').value.trim(),
      category: $('miCat').value.trim(),
      type: S.miType,
      description: $('miDesc').value.trim(),
      allowToppings: $('miToppings').checked,
      active: $('miActive').checked
    };
    if (S.miType === 'single') body.price = $('miPFixed').value;
    else body.prices = { S: $('miPS').value, M: $('miPM').value, L: $('miPL').value };
    $('modalErr').textContent = '';
    try {
      const d = S.editingId
        ? await api('PUT', '/api/menu/items/' + S.editingId, body)
        : await api('POST', '/api/menu/items', body);
      menuChanged(d.menu);
      closeModal();
      toast('Item saved');
    } catch (e) { $('modalErr').textContent = e.message; }
  }

  /* ---------- settings ---------- */
  function fillSettings() {
    if (!S.token) return;
    const s = S.settings, tp = s.toppingPrices || {};
    $('sShopName').value = s.shopName || '';
    $('sTagline').value = s.tagline || '';
    $('sAddress').value = s.address || '';
    $('sPhones').value = (s.phones || []).join('\n');
    $('cTagline').checked = s.showTagline !== false;
    $('cAddress').checked = s.showAddress !== false;
    $('cPhones').checked = s.showPhones !== false;
    $('cFooter').checked = s.showFooter !== false;
    $('sDelFee').value = s.deliveryFee || 0;
    $('sTopS').value = tp.S || 0;
    $('sTopM').value = tp.M || 0;
    $('sTopL').value = tp.L || 0;
    $('sFooter').value = s.receiptFooter || '';
    $('sAutoPrint').checked = !!s.autoPrint;
    S.width = s.receiptWidth === 58 ? 58 : 80;
    setSeg('segWidth', String(S.width));
    ['pwCur', 'pwNew', 'pwNew2'].forEach(id => { $(id).value = ''; });
    $('pwShow').checked = false; togglePwShow();
  }
  async function saveSettings() {
    const body = {
      shopName: $('sShopName').value.trim(),
      tagline: $('sTagline').value.trim(),
      address: $('sAddress').value.trim(),
      phones: $('sPhones').value.split(/\n+/).map(x => x.trim()).filter(Boolean),
      showTagline: $('cTagline').checked,
      showAddress: $('cAddress').checked,
      showPhones: $('cPhones').checked,
      showFooter: $('cFooter').checked,
      deliveryFee: $('sDelFee').value || 0,
      toppingPrices: { S: $('sTopS').value || 0, M: $('sTopM').value || 0, L: $('sTopL').value || 0 },
      receiptWidth: S.width,
      receiptFooter: $('sFooter').value.trim(),
      autoPrint: $('sAutoPrint').checked
    };
    try {
      const d = await api('PUT', '/api/settings', body);
      S.settings = d.settings;
      touch();
      applySettings(); renderMenu(); renderDrinks(); renderCart();
      toast('Settings saved');
    } catch (e) { toast(e.message, true); }
  }
  function togglePwShow() {
    const t = $('pwShow').checked ? 'text' : 'password';
    ['pwCur', 'pwNew', 'pwNew2'].forEach(id => { $(id).type = t; });
  }
  async function savePassword() {
    const cur = $('pwCur').value, p1 = $('pwNew').value, p2 = $('pwNew2').value;
    if (!cur) return toast('Enter your current password', true);
    if (p1.length < 4 || p1.length > 32) return toast('New password must be 4 to 32 characters', true);
    if (p1 !== p2) return toast('New passwords do not match', true);
    try {
      const d = await api('POST', '/api/settings/password', { current: cur, password: p1 });
      S.settings = d.settings;
      setToken(d.token);
      ['pwCur', 'pwNew', 'pwNew2'].forEach(id => { $(id).value = ''; });
      toast('Password changed');
    } catch (e) { toast(e.message, true); }
  }
  async function resetPassword() {
    const cur = $('pwCur').value;
    if (!cur) return toast('Enter your current password first', true);
    if (!confirm('Reset to the default password (adminpizzacity)?')) return;
    try {
      const d = await api('POST', '/api/settings/password', { current: cur, reset: true });
      S.settings = d.settings;
      setToken(d.token);
      ['pwCur', 'pwNew', 'pwNew2'].forEach(id => { $(id).value = ''; });
      toast('Password reset to default');
    } catch (e) { toast(e.message, true); }
  }
  async function runBackup() {
    try {
      const d = await api('POST', '/api/backup');
      touch();
      $('backupInfo').textContent = 'Saved to ' + d.backup.folder + ' at ' + new Date(d.backup.time).toLocaleTimeString('en-GB');
      toast('Backup done');
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- views ---------- */
  function showViewRaw(name) {
    S.view = name;
    qsa('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === name));
    qsa('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + name));
    touch();
    if (name === 'counter') refreshToday();
    if (name === 'dash') loadDash();
    if (name === 'hist') loadHist();
    if (name === 'menu-mgr') renderMM();
    if (name === 'settings') fillSettings();
  }
  async function showView(name) {
    if (PROTECTED.indexOf(name) >= 0 && !S.token) {
      const ok = await askLogin();
      if (!ok) return;
    }
    showViewRaw(name);
  }

  /* ---------- events ---------- */
  function bind() {
    qsa('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));

    bindSeg('segType', setType);
    bindSeg('segPay', setPay);
    bindSeg('segTheme', applyTheme);
    bindSeg('segWidth', v => { S.width = Number(v) === 58 ? 58 : 80; });
    bindSeg('miTypeSeg', setMiType);

    $('catTabs').addEventListener('click', e => {
      const b = e.target.closest('.cat-btn');
      if (!b) return;
      S.cat = b.dataset.cat;
      renderCats(); renderMenu();
    });
    $('menuGrid').addEventListener('click', e => {
      const card = e.target.closest('.menu-card');
      if (!card) return;
      const it = S.menu.items.find(x => x.id === card.dataset.id);
      if (!it) return;
      const sz = e.target.closest('.mc-sz');
      if (it.type === 'single') addToCart(it.id, '');
      else if (sz) addToCart(it.id, sz.dataset.size);
    });
    $('drinksGrid').addEventListener('click', e => {
      const b = e.target.closest('.drink-btn');
      if (b) addToCart(b.dataset.id, b.dataset.size);
    });
    $('cartTable').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      const tr = e.target.closest('tr[data-i]');
      if (!b || !tr) return;
      const l = S.cart[Number(tr.dataset.i)];
      if (!l) return;
      const a = b.dataset.act;
      if (a === 'inc' && l.qty < 999) l.qty++;
      else if (a === 'dec') { l.qty--; if (l.qty <= 0) S.cart.splice(Number(tr.dataset.i), 1); }
      else if (a === 'del') S.cart.splice(Number(tr.dataset.i), 1);
      else if (a === 'tinc' && l.toppings < 20) l.toppings++;
      else if (a === 'tdec' && l.toppings > 0) l.toppings--;
      renderCart();
    });
    ['iDiscount', 'iDelivery', 'iCashRecv', 'cTable', 'cName', 'cPhone', 'cAddr', 'iNote'].forEach(id =>
      $(id).addEventListener('input', () => renderTotals()));

    $('btnPrint').addEventListener('click', () => saveOrder(true));
    $('btnSaveOnly').addEventListener('click', () => saveOrder(false));
    $('btnClear').addEventListener('click', () => { if (!S.cart.length || confirm('Clear this order?')) clearOrder(); });

    $('recentList').addEventListener('click', orderAction);
    $('dashOrders').addEventListener('click', orderAction);
    $('histTable').addEventListener('click', orderAction);

    $('omPrint').addEventListener('click', () => { const o = S.known.get(S.viewId); if (o) printReceipt(o); });
    $('omCancelOrder').addEventListener('click', async () => {
      const o = S.known.get(S.viewId);
      if (!o) return;
      if (await cancelOrder(o)) closeOrder();
    });
    $('omClose').addEventListener('click', closeOrder);
    $('omX').addEventListener('click', closeOrder);
    $('orderModal').addEventListener('click', e => { if (e.target === $('orderModal')) closeOrder(); });

    $('btnSearch').addEventListener('click', loadHist);
    $('hq').addEventListener('keydown', e => { if (e.key === 'Enter') loadHist(); });
    $('hType').addEventListener('change', loadHist);
    $('hFrom').addEventListener('change', loadHist);
    $('hTo').addEventListener('change', loadHist);

    $('mmCatTabs').addEventListener('click', e => {
      const b = e.target.closest('.cat-btn');
      if (!b) return;
      S.mmCat = b.dataset.cat;
      renderMM();
    });
    $('mmList').addEventListener('click', mmAction);
    $('btnAddItem').addEventListener('click', () => openModal(null));
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      if (b.dataset.action === 'close-menu-item') closeModal();
      if (b.dataset.action === 'save-menu-item') saveModal();
    });
    $('itemModal').addEventListener('click', e => { if (e.target === $('itemModal')) closeModal(); });

    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('btnSavePw').addEventListener('click', savePassword);
    $('btnResetPw').addEventListener('click', resetPassword);
    $('pwShow').addEventListener('change', togglePwShow);
    $('btnBackup').addEventListener('click', runBackup);

    $('pinSubmit').addEventListener('click', submitPin);
    $('pinCancel').addEventListener('click', () => closeLogin(false));
    $('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitPin(); });
    $('pinEye').addEventListener('click', () => {
      const i = $('pinInput');
      i.type = i.type === 'password' ? 'text' : 'password';
      i.focus();
    });
    $('loginOverlay').addEventListener('click', e => { if (e.target === $('loginOverlay')) closeLogin(false); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if ($('loginOverlay').style.display === 'grid') closeLogin(false);
      else if ($('orderModal').style.display === 'grid') closeOrder();
      else if ($('itemModal').style.display === 'grid') closeModal();
    });

    $('lockBtn').addEventListener('click', async () => {
      if (S.token) lockNow(false);
      else if (await askLogin()) toast('Admin unlocked');
    });

    // any use of the admin screens keeps them unlocked
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(ev =>
      document.addEventListener(ev, touch, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { lockTick(); refreshToday(); } });

    $('retryNow').addEventListener('click', ping);
    $('statusBtn').addEventListener('click', ping);
  }

  /* ---------- init ---------- */
  function init() {
    let theme = 'dark';
    try { theme = localStorage.getItem('pc_theme') || 'dark'; } catch (e) {}
    applyTheme(theme === 'light' ? 'light' : 'dark');

    // restore admin session after a refresh, only if still within 3 minutes
    try {
      const t = sessionStorage.getItem('pc_token') || '';
      const act = Number(sessionStorage.getItem('pc_act')) || 0;
      if (t && Date.now() - act < LOCK_MS) { S.token = t; S.lastAct = act; }
      else { sessionStorage.removeItem('pc_token'); sessionStorage.removeItem('pc_act'); }
    } catch (e) {}

    const t = new Date();
    const from = new Date(t.getTime() - 30 * 86400000);
    $('hTo').value = dstr(t);
    $('hFrom').value = dstr(from);

    bind();
    wipeProtected();
    updateLockUI();
    setType(S.type);
    setPay(S.pay);
    renderCart();
    renderToday();
    ping();
    setInterval(ping, 5000);
    setInterval(lockTick, 1000);
    setInterval(() => { if (S.view === 'counter' && !document.hidden) refreshToday(); }, 30000);
    loadState().then(refreshToday).catch(() => {});
  }
  init();
})();
