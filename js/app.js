/*
 * Interface : mode CAISSE (vente) et mode ADMINISTRATION (configuration, bilan, export).
 * Navigation par adresse (#caisse, #admin/produits…) pour que le bouton « retour »
 * du téléphone fonctionne. Aucune dépendance externe.
 */
(function () {
  'use strict';
  const L = window.Logic, DB = window.DB, X = window.Xlsx;
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const money = L.formatEuros;
  const UNITS = ['unité', 'pièce', 'tranche', 'portion', 'feuille', 'g', 'kg', 'mL', 'cL', 'L', 'sachet', 'bouteille', 'canette'];

  // État de l'écran. Les données de référence (produits…) sont une copie de la base,
  // rechargée après chaque modification ; les ventes sont lues directement en base.
  const S = {
    settings: {}, events: [], categories: [], products: [], ingredients: [],
    cart: [], cartId: null, payment: null, survey: null, saving: false, lastSaved: null, menuPick: null,
    unlocked: false, pinEntry: ''
  };
  let renderSeq = 0;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Données ----------

  async function loadAll() {
    const [events, categories, products, ingredients, settings] = await Promise.all([
      DB.getAll('events'), DB.getAll('categories'), DB.getAll('products'), DB.getAll('ingredients'), DB.getSettings()
    ]);
    S.events = events.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
    S.categories = categories.sort((a, b) => a.order - b.order);
    S.products = products.sort((a, b) => a.order - b.order);
    S.ingredients = ingredients.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    S.settings = settings;
  }

  const eventById = id => S.events.find(e => e.id === id) || null;
  const currentEvent = () => S.events.find(e => e.id === S.settings.currentEventId && !e.archived) || null;
  const pickEvent = id => eventById(id) || currentEvent() || S.events[0] || null;

  /** Produits regroupés par catégorie, dans l'ordre des catégories ; « Autres » à la fin. */
  function groupByCategory(products) {
    const groups = S.categories.map((c, i) => ({ id: c.id, name: c.name, color: i % 8, products: [] }));
    const byId = L.indexById(groups);
    const other = { id: '', name: 'Autres', color: 7, products: [] };
    for (const p of products) (byId[p.categoryId] || other).products.push(p);
    return [...groups, other].filter(g => g.products.length);
  }

  // ---------- Messages ----------

  let toastTimer;
  function toast(msg, type = 'ok', ms = 2500) {
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + type;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }
  toastEl.addEventListener('click', () => { toastEl.hidden = true; });

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------- Navigation ----------

  function go(path) {
    if (location.hash === '#' + path) render();
    else location.hash = path;
  }

  async function render() {
    const seq = ++renderSeq;
    const [name, a, b] = (location.hash.slice(1) || 'caisse').split('/').map(decodeURIComponent);
    if (name !== 'admin') S.unlocked = false;
    if (name === 'admin' && !S.unlocked) {
      if (S.settings.pin) return renderPin();
      S.unlocked = true;
    }
    if (name === 'caisse') return renderCaisse();
    let html;
    try {
      if (name === 'ventes') html = await viewRecentSales();
      else if (name === 'vente') html = await viewSale(a, 'caisse');
      else if (name === 'admin') html = await viewAdmin(a || 'evenements', b);
      else return go('caisse');
    } catch (e) {
      console.error(e);
      html = `<div class="page"><p class="error">Erreur : ${esc(e.message)}</p>
        <button class="btn" data-action="go" data-to="caisse">Retour à la caisse</button></div>`;
    }
    if (seq !== renderSeq) return; // une navigation plus récente a eu lieu
    document.body.className = 'is-page';
    app.innerHTML = html;
    window.scrollTo(0, 0);
  }

  // ==========================================================================
  // MODE CAISSE
  // ==========================================================================

  function renderCaisse() {
    renderSeq++;
    document.body.className = 'is-caisse';
    const ev = currentEvent();
    if (!ev) {
      app.innerHTML = `<div class="page center">
        <h1>Caisse buvette</h1>
        <p class="big">Aucun événement ouvert.</p>
        <p>Créez ou ouvrez un événement dans l'administration.</p>
        <button class="btn primary big" data-action="go" data-to="admin/evenements">Ouvrir l'administration</button>
      </div>`;
      return;
    }
    S.menuPick = null;
    app.innerHTML = `<div class="caisse">
      <header class="topbar">
        <div class="ev">${esc(ev.name)}</div>
        <button class="tb" data-action="go" data-to="ventes">Dernières ventes</button>
        <button class="tb" data-action="go" data-to="admin">⚙ Admin</button>
      </header>
      <main class="products" id="products"></main>
      <aside class="cart" id="cart"></aside>
    </div>`;
    updateProducts();
    updateCart();
  }

  const catColor = p => {
    const i = S.categories.findIndex(c => c.id === p.categoryId);
    return i < 0 ? 7 : i % 8;
  };

  function productButton(p, action, color) {
    return `<button class="pbtn c${color}" data-action="${action}" data-id="${p.id}">
      <span class="pname">${esc(p.name)}</span>${action === 'add' ? `<span class="pprice">${money(p.price)}</span>
      <span class="pqty" data-qty="${p.id}" hidden></span>` : ''}</button>`;
  }

  /** Options encore disponibles (produits actifs) d'une étape de menu. */
  const stepOptions = step => step.options.map(id => S.products.find(p => p.id === id)).filter(p => p && p.active !== false);

  /** Grille des produits, ou choix pas à pas d'un menu (sandwich → boisson → crêpe). */
  function updateProducts() {
    const el = document.getElementById('products');
    if (!el) return;
    const mp = S.menuPick;
    if (mp) {
      const step = mp.product.menu[mp.step];
      el.innerHTML = `<div class="picker">
        <div class="pk-head"><b>${esc(mp.product.name)} — ${money(mp.product.price)}</b><span>Étape ${mp.step + 1} / ${mp.product.menu.length}</span></div>
        <div class="pk-actions">
          <button class="btn" data-action="pick-back">← Retour</button>
          <button class="btn danger" data-action="pick-cancel">Annuler le menu</button>
        </div>
        ${mp.choices.length ? `<p class="pk-done">${mp.choices.map(c => `✓ ${esc(c.name)}`).join('<br>')}</p>` : ''}
        <h2 class="pk-title">Choisir : ${esc(step.label)}</h2>
        <div class="pgrid">${stepOptions(step).map(p => productButton(p, 'pick', catColor(p))).join('')}</div>
      </div>`;
      el.scrollTop = 0;
      return;
    }
    const groups = groupByCategory(S.products.filter(p => p.active !== false));
    el.innerHTML = groups.length ? groups.map(g => `<section>
        <h2>${esc(g.name)}</h2>
        <div class="pgrid">${g.products.map(p => productButton(p, 'add', g.color)).join('')}</div>
      </section>`).join('')
      : `<p class="empty">Aucun produit actif.<br>Ajoutez des produits dans l'administration.</p>`;
  }

  function addToCart(product, choices) {
    if (!S.cart.length) S.cartId = L.uuid();
    setCart(L.cartAdd(S.cart, product, choices));
  }

  /** Passe à l'étape suivante du menu (les étapes sans option disponible sont sautées). */
  function advanceMenu() {
    const mp = S.menuPick;
    while (mp.step < mp.product.menu.length && !stepOptions(mp.product.menu[mp.step]).length) mp.step++;
    if (mp.step < mp.product.menu.length) return updateProducts();
    S.menuPick = null;
    updateProducts();
    addToCart(mp.product, mp.choices);
  }

  /** Met à jour uniquement le panier (la grille de produits garde sa position de défilement). */
  function updateCart() {
    const el = document.getElementById('cart');
    if (!el) return;
    const empty = S.cart.length === 0;
    const ev = currentEvent();
    const question = ev && ev.surveyQuestion;
    const needSurvey = !!question && !S.survey;
    const ready = !empty && S.payment && !needSurvey && !S.saving;
    const label = S.saving ? 'Enregistrement…'
      : empty ? 'VALIDER LA VENTE'
      : needSurvey ? 'Répondre au sondage'
      : !S.payment ? 'Choisir : Espèces ou Carte' : 'VALIDER LA VENTE';
    el.innerHTML = `
      <div class="cart-head"><span>PANIER</span>${empty ? '' : '<button class="link" data-action="clear-cart">Vider le panier</button>'}</div>
      <div class="cart-lines">${empty ? (S.lastSaved
        ? `<p class="saved" id="saved">✓ Vente n°${S.lastSaved.number} enregistrée — ${money(S.lastSaved.total)} (${L.PAYMENTS[S.lastSaved.payment]})</p>`
        : '<p class="hint">Touchez un produit pour l\'ajouter.</p>') : S.cart.map(l => `
        <div class="cline">
          <div class="cname">${esc(l.name)}${l.qty > 1 ? ` <b class="x">×${l.qty}</b>` : ''}${l.choices ? `<div class="cdet">${esc(L.choicesText(l))}</div>` : ''}</div>
          <div class="camt">${money(l.unitPrice * l.qty)}</div>
          <button class="qbtn" data-action="dec" data-id="${esc(l.key)}" aria-label="Retirer un ${esc(l.name)}">−</button>
          <button class="qbtn" data-action="inc" data-id="${esc(l.key)}" aria-label="Ajouter un ${esc(l.name)}">+</button>
        </div>`).join('')}</div>
      <div class="cart-total"><span>TOTAL</span><span id="total">${money(L.cartTotal(S.cart))}</span></div>
      ${question ? `<div class="survey ${S.survey ? 'done' : ''}">
        <div class="sq">${esc(question)}</div>
        <div class="sbtns">${Object.entries(L.SURVEY).map(([k, v]) => `<button class="sbtn ${S.survey === k ? 'sel' : ''}" data-action="survey" data-answer="${k}" ${empty || S.saving ? 'disabled' : ''}>${S.survey === k ? '✓ ' : ''}${v.toUpperCase()}</button>`).join('')}</div>
      </div>` : ''}
      <div class="pay-row">
        ${Object.entries(L.PAYMENTS).map(([k, v]) => `<button class="pay ${S.payment === k ? 'sel' : ''}" data-action="pay" data-pay="${k}" ${empty || S.saving ? 'disabled' : ''}>${S.payment === k ? '✓ ' : ''}${v.toUpperCase()}</button>`).join('')}
      </div>
      <button class="validate" id="validate" data-action="validate" ${ready ? '' : 'disabled'}>${label}</button>`;
    for (const b of document.querySelectorAll('[data-qty]')) {
      const q = S.cart.filter(x => x.productId === b.dataset.qty).reduce((n, x) => n + x.qty, 0);
      b.hidden = !q;
      b.textContent = q || '';
    }
    const lines = el.querySelector('.cart-lines');
    lines.scrollTop = empty ? 0 : lines.scrollHeight;
  }

  function setCart(cart) {
    S.cart = cart;
    S.lastSaved = null;
    if (!cart.length) { S.payment = null; S.cartId = null; S.survey = null; }
    updateCart();
  }

  /**
   * Validation d'une vente : protégée contre le double clic (drapeau `saving` +
   * bouton désactivé + identifiant unique du panier). Le panier n'est vidé
   * qu'APRÈS confirmation de l'écriture en base.
   */
  async function validateSale() {
    if (S.saving || !S.cart.length || !S.payment) return;
    const ev = currentEvent();
    if (!ev) return toast('Aucun événement ouvert.', 'err', 4000);
    if (ev.surveyQuestion && !S.survey) return;
    S.saving = true;
    updateCart();
    let saved;
    try {
      const sale = L.buildSale({ id: S.cartId || L.uuid(), eventId: ev.id, cart: S.cart, payment: S.payment, deviceId: S.settings.deviceId, survey: ev.surveyQuestion ? S.survey : null });
      saved = await DB.addSale(sale);
    } catch (e) {
      if (!(e && e.name === 'ConstraintError')) { // ConstraintError = ce panier est déjà enregistré
        S.saving = false;
        updateCart();
        console.error(e);
        toast("ERREUR : la vente n'a PAS été enregistrée. " + (e && e.message ? e.message : e), 'err', 0);
        return;
      }
    }
    S.saving = false;
    setCart([]);
    // Confirmation affichée dans le panier, là où regarde la personne à la caisse
    S.lastSaved = saved || null;
    updateCart();
  }

  // ---------- Dernières ventes / détail / annulation ----------

  function salesList(sales, prefix, withDate) {
    if (!sales.length) return '<p class="muted">Aucune vente pour le moment.</p>';
    return `<ul class="sales">${sales.map(s => {
      const off = L.isCancelled(s);
      return `<li><button class="srow ${off ? 'cancelled' : ''}" data-action="go" data-to="${prefix}/${s.id}">
        <span class="sn">#${s.number}</span>
        <span class="st">${withDate ? L.formatDate(s.createdAt) + ' ' : ''}${L.formatTime(s.createdAt)}${off ? ' <span class="tag red">ANNULÉE</span>' : ''}</span>
        <span class="sa">${money(s.total)}</span>
        <span class="sp">${L.PAYMENTS[s.payment] || s.payment}</span>
      </button></li>`;
    }).join('')}</ul>`;
  }

  const byNumberDesc = (a, b) => (b.number || 0) - (a.number || 0);

  async function viewRecentSales() {
    const ev = currentEvent();
    if (!ev) return pageHeader('Dernières ventes', 'caisse') + '<div class="page"><p>Aucun événement ouvert.</p></div>';
    const sales = (await DB.salesByEvent(ev.id)).sort(byNumberDesc).slice(0, 50);
    return pageHeader('Dernières ventes', 'caisse') + `<div class="page">
      <p class="muted">Touchez une vente pour voir le détail ou l'annuler.</p>${salesList(sales, 'vente', false)}</div>`;
  }

  function pageHeader(title, back) {
    return `<header class="adminbar"><button class="btn back" data-action="go" data-to="${back}">← Retour</button><h1>${esc(title)}</h1></header>`;
  }

  async function viewSale(id, ctx) {
    const sale = await DB.get('sales', id);
    const back = ctx === 'caisse' ? 'ventes' : `admin/historique/${sale ? sale.eventId : ''}`;
    if (!sale) return (ctx === 'caisse' ? pageHeader('Vente', back) : '') + '<div class="page"><p>Vente introuvable.</p></div>';
    const ev = eventById(sale.eventId);
    const off = L.isCancelled(sale);
    const editable = !off && ev && !ev.archived;
    const body = `<div class="card">
      <h2>Vente n°${sale.number} ${off ? '<span class="tag red">ANNULÉE</span>' : ''}</h2>
      <table class="t kv">
        <tr><th>Date</th><td>${L.formatDate(sale.createdAt)} à ${L.formatTime(sale.createdAt)}</td></tr>
        <tr><th>Événement</th><td>${esc(ev ? ev.name : '?')}</td></tr>
        <tr><th>Paiement</th><td>${L.PAYMENTS[sale.payment] || esc(sale.payment)}</td></tr>
        ${sale.survey ? `<tr><th>Sondage</th><td>${L.SURVEY[sale.survey]}</td></tr>` : ''}
        ${off ? `<tr><th>Annulée le</th><td>${L.formatDate(sale.cancelledAt)} à ${L.formatTime(sale.cancelledAt)}</td></tr>
        <tr><th>Raison</th><td>${esc(sale.cancelReason || '—')}</td></tr>` : ''}
      </table>
      <table class="t">
        <tr><th>Produit</th><th class="n">Qté</th><th class="n">Prix</th><th class="n">Total</th></tr>
        ${sale.lines.map(l => `<tr><td>${esc(l.name)}${l.choices ? `<div class="muted">${esc(L.choicesText(l))}</div>` : ''}</td><td class="n">${l.qty}</td><td class="n">${money(l.unitPrice)}</td><td class="n">${money(l.total)}</td></tr>`).join('')}
        <tr class="tot"><td colspan="3">TOTAL</td><td class="n">${money(sale.total)}</td></tr>
      </table>
      ${editable ? `<div class="actions">
        <button class="btn danger" data-action="cancel-sale" data-id="${sale.id}">Annuler cette vente</button>
        ${ev.id === (currentEvent() || {}).id ? `<button class="btn" data-action="correct-sale" data-id="${sale.id}">Corriger (annuler et reprendre dans le panier)</button>` : ''}
      </div>` : ''}
    </div>`;
    if (ctx === 'caisse') return pageHeader(`Vente n°${sale.number}`, back) + `<div class="page">${body}</div>`;
    return `<p><button class="btn sm" data-action="go" data-to="${back}">← Historique</button></p>${body}`;
  }

  async function cancelSale(id) {
    const sale = await DB.get('sales', id);
    if (!sale || L.isCancelled(sale)) return;
    const reason = prompt(`Annuler la vente n°${sale.number} (${money(sale.total)}, ${L.PAYMENTS[sale.payment]}) ?\n\nElle restera visible comme ANNULÉE et sera exclue du bilan.\nRaison (facultatif) :`, '');
    if (reason === null) return;
    await DB.put('sales', L.cancelSale(sale, reason));
    toast(`Vente n°${sale.number} annulée.`);
    render();
  }

  async function correctSale(id) {
    const sale = await DB.get('sales', id);
    if (!sale || L.isCancelled(sale)) return;
    if (!confirm(`Corriger la vente n°${sale.number} (${money(sale.total)}) ?\n\nElle sera marquée ANNULÉE et ses produits remis dans le panier pour être ressaisis.`)) return;
    if (S.cart.length && !confirm('Le panier en cours sera remplacé. Continuer ?')) return;
    await DB.put('sales', L.cancelSale(sale, `Correction (ressaisie)`));
    S.cart = sale.lines.map(L.lineToCart);
    S.cartId = L.uuid();
    S.payment = null;
    S.survey = sale.survey || null;
    toast(`Vente n°${sale.number} annulée : corrigez le panier puis validez.`, 'ok', 4000);
    go('caisse');
  }

  // ---------- Code PIN ----------

  function renderPin() {
    renderSeq++;
    document.body.className = 'is-page';
    S.pinEntry = '';
    app.innerHTML = `<div class="pinpad">
      <h1>Administration</h1>
      <p>Entrez le code PIN</p>
      <div class="pindots" id="pindots">&nbsp;</div>
      <p class="error" id="pinerr" hidden>Code incorrect</p>
      <div class="keys">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-action="pin-key" data-k="${n}">${n}</button>`).join('')}
        <button class="key" data-action="pin-del" aria-label="Effacer">⌫</button>
        <button class="key" data-action="pin-key" data-k="0">0</button>
        <button class="key ok" data-action="pin-ok">OK</button>
      </div>
      <button class="btn" data-action="go" data-to="caisse">← Retour à la caisse</button>
    </div>`;
  }

  function pinUpdate(check) {
    const dots = document.getElementById('pindots');
    if (!dots) return;
    dots.innerHTML = S.pinEntry ? '•'.repeat(S.pinEntry.length) : '&nbsp;';
    const pin = String(S.settings.pin || '');
    if (S.pinEntry === pin) { S.unlocked = true; render(); return; }
    const err = document.getElementById('pinerr');
    if (check || S.pinEntry.length >= pin.length) {
      if (S.pinEntry.length) err.hidden = false;
      S.pinEntry = '';
      dots.innerHTML = '&nbsp;';
    } else if (S.pinEntry.length) err.hidden = true;
  }

  // ==========================================================================
  // MODE ADMINISTRATION
  // ==========================================================================

  const TABS = [
    ['evenements', 'Événements'], ['produits', 'Produits'], ['ingredients', 'Ingrédients'],
    ['historique', 'Historique'], ['bilan', 'Bilan'], ['donnees', 'Export & sauvegarde'], ['reglages', 'Code PIN']
  ];

  async function viewAdmin(tab, arg) {
    const active = { evenement: 'evenements', produit: 'produits', ingredient: 'ingredients', vente: 'historique' }[tab] || tab;
    let body;
    switch (tab) {
      case 'evenements': body = await viewEvents(); break;
      case 'evenement': body = viewEventForm(arg); break;
      case 'produits': body = viewProducts(); break;
      case 'produit': body = viewProductForm(arg); break;
      case 'ingredients': body = viewIngredients(); break;
      case 'ingredient': body = viewIngredientForm(arg); break;
      case 'historique': body = await viewHistory(arg); break;
      case 'vente': body = await viewSale(arg, 'admin'); break;
      case 'bilan': body = await viewBilan(arg); break;
      case 'donnees': body = await viewData(arg); break;
      case 'reglages': body = viewSettings(); break;
      default: body = '<p>Page introuvable.</p>';
    }
    return `<header class="adminbar">
        <button class="btn back" data-action="go" data-to="caisse">← Caisse</button>
        <h1>Administration</h1>
      </header>
      <nav class="tabs">${TABS.map(([k, l]) => `<button class="tab ${k === active ? 'on' : ''}" data-action="go" data-to="admin/${k}">${l}</button>`).join('')}</nav>
      <div class="page">${body}</div>`;
  }

  function eventSelect(ev, tab) {
    return `<label class="evsel">Événement :
      <select data-change="event-select" data-tab="${tab}">
        ${S.events.map(e => `<option value="${e.id}" ${e.id === ev.id ? 'selected' : ''}>${esc(e.name)}${e.archived ? ' (archivé)' : ''}</option>`).join('')}
      </select></label>`;
  }

  const noEvent = '<p class="note">Aucun événement. Créez-en un dans l\'onglet « Événements ».</p>';

  // ---------- Événements ----------

  async function viewEvents() {
    const cur = currentEvent();
    const counts = await Promise.all(S.events.map(e => DB.countSalesByEvent(e.id)));
    const countById = {};
    S.events.forEach((e, i) => { countById[e.id] = counts[i]; });
    const intro = (!S.events.length || !S.products.length) ? `<div class="note">
      <b>Pour commencer :</b>
      <ol><li>Créez un événement (bouton ci-dessous).</li>
      <li>Onglet <b>Produits</b> : créez les catégories puis les produits avec leur prix.</li>
      <li>Facultatif : onglet <b>Ingrédients</b>, puis la recette dans chaque produit.</li>
      <li>Touchez <b>← Caisse</b> pour vendre.</li></ol></div>` : '';
    const card = e => {
      const isCur = cur && cur.id === e.id;
      return `<div class="card ${isCur ? 'current' : ''}">
        <div class="lrow0"><div class="grow"><b class="evname">${esc(e.name)}</b>
          ${isCur ? ' <span class="tag green">EN CAISSE</span>' : ''}${e.archived ? ' <span class="tag">Archivé</span>' : ''}
          <div class="muted">${esc(L.formatPeriod(e)) || 'Pas de date'} · ${countById[e.id]} vente(s)</div>
          ${e.description ? `<div class="muted">${esc(e.description)}</div>` : ''}</div></div>
        <div class="actions">
          ${!e.archived && !isCur ? `<button class="btn primary sm" data-action="use-event" data-id="${e.id}">Utiliser en caisse</button>` : ''}
          <button class="btn sm" data-action="go" data-to="admin/bilan/${e.id}">Bilan</button>
          <button class="btn sm" data-action="go" data-to="admin/historique/${e.id}">Historique</button>
          <button class="btn sm" data-action="go" data-to="admin/evenement/${e.id}">Modifier / stock initial</button>
          ${e.archived ? `<button class="btn sm" data-action="unarchive-event" data-id="${e.id}">Réactiver</button>`
                       : `<button class="btn sm" data-action="archive-event" data-id="${e.id}">Archiver</button>`}
          <button class="btn sm danger" data-action="delete-event" data-id="${e.id}">Supprimer</button>
        </div></div>`;
    };
    const open = S.events.filter(e => !e.archived), archived = S.events.filter(e => e.archived);
    return `${intro}
      <div class="toolbar"><button class="btn primary" data-action="go" data-to="admin/evenement/new">+ Nouvel événement</button></div>
      ${open.map(card).join('') || '<p class="muted">Aucun événement en cours.</p>'}
      ${archived.length ? `<h2>Archivés (lecture seule)</h2>${archived.map(card).join('')}` : ''}`;
  }

  function viewEventForm(id) {
    const ev = id === 'new' ? null : eventById(id);
    if (id !== 'new' && !ev) return '<p>Événement introuvable.</p>';
    const today = L.localDay(new Date().toISOString());
    const stock = (ev && ev.initialStock) || {};
    return `<form class="form card" data-form="event" data-id="${ev ? ev.id : ''}">
      <h2>${ev ? "Modifier l'événement" : 'Nouvel événement'}</h2>
      <label>Nom *<input name="name" required maxlength="100" value="${esc(ev ? ev.name : '')}" placeholder="ex. Challenge Lamouret 2026"></label>
      <div class="two">
        <label>Date de début<input type="date" name="startDate" value="${esc(ev ? ev.startDate : today)}"></label>
        <label>Date de fin<input type="date" name="endDate" value="${esc(ev ? ev.endDate : today)}"></label>
      </div>
      <label>Description (facultatif)<textarea name="description" rows="2" maxlength="500">${esc(ev ? ev.description : '')}</textarea></label>
      <label>Question de sondage (facultatif)<input name="surveyQuestion" maxlength="200" value="${esc(ev ? ev.surveyQuestion || '' : '')}" placeholder="ex. Seriez-vous intéressé(e) par un t-shirt de l'événement ?"></label>
      <p class="muted">Si une question est saisie, elle s'affiche à la caisse avant chaque validation, avec OUI / NON / DÉJÀ POSÉE (client qui revient). Laissez vide pour ne plus la poser. Résultats dans le Bilan et l'export Excel.</p>
      ${ev ? '' : '<label class="check"><input type="checkbox" name="useNow" checked> Ouvrir cet événement en caisse</label>'}
      <fieldset><legend>Stock initial des ingrédients (facultatif)</legend>
        <p class="muted">Sert à calculer le stock théorique restant pour cet événement.</p>
        ${S.ingredients.length ? S.ingredients.map(i => `<label class="inline"><span class="grow">${esc(i.name)}</span>
          <span><input name="stock_${i.id}" inputmode="decimal" autocomplete="off" value="${stock[i.id] != null ? L.formatQty(stock[i.id]) : ''}"> <span class="unit">${esc(i.unit)}</span></span></label>`).join('')
        : '<p class="muted">Aucun ingrédient défini (onglet Ingrédients).</p>'}
      </fieldset>
      <div class="actions">
        <button class="btn primary" type="submit">Enregistrer</button>
        <button class="btn" type="button" data-action="go" data-to="admin/evenements">Annuler</button>
      </div>
    </form>`;
  }

  async function saveEvent(f, fd) {
    const name = String(fd.get('name') || '').trim();
    if (!name) throw new Error('Le nom est obligatoire.');
    const startDate = fd.get('startDate') || '', endDate = fd.get('endDate') || '';
    if (startDate && endDate && endDate < startDate) throw new Error('La date de fin est avant la date de début.');
    const initialStock = {};
    for (const i of S.ingredients) {
      const v = L.parseDecimal(fd.get('stock_' + i.id));
      if (v === null) continue;
      if (Number.isNaN(v)) throw new Error(`Stock initial invalide pour « ${i.name} ».`);
      initialStock[i.id] = v;
    }
    const description = String(fd.get('description') || '').trim();
    const surveyQuestion = String(fd.get('surveyQuestion') || '').trim();
    const old = f.dataset.id ? eventById(f.dataset.id) : null;
    const ev = old
      ? { ...old, name, startDate, endDate, description, surveyQuestion, initialStock }
      : { id: L.uuid(), name, startDate, endDate, description, surveyQuestion, initialStock, archived: false, createdAt: new Date().toISOString() };
    await DB.put('events', ev);
    if (!old && fd.get('useNow')) await DB.setSetting('currentEventId', ev.id);
    await loadAll();
    toast('Événement enregistré.');
    go('admin/evenements');
  }

  // ---------- Produits & catégories ----------

  function viewProducts() {
    const ib = L.indexById(S.ingredients);
    const showCost = S.ingredients.some(i => L.ingredientUnitCost(i) != null);
    const cats = `<div class="card"><h2>Catégories</h2>
      <p class="muted">L'ordre des catégories est celui de l'écran de caisse.</p>
      ${S.categories.map((c, i) => `<div class="lrow">
        <span class="dot c${i % 8}"></span><span class="grow">${esc(c.name)}</span>
        <button class="btn sm" data-action="cat-move" data-id="${c.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
        <button class="btn sm" data-action="cat-move" data-id="${c.id}" data-dir="1" ${i === S.categories.length - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>
        <button class="btn sm" data-action="cat-rename" data-id="${c.id}">Renommer</button>
        <button class="btn sm danger" data-action="cat-delete" data-id="${c.id}" aria-label="Supprimer">✕</button>
      </div>`).join('') || '<p class="muted">Aucune catégorie.</p>'}
      <form class="addrow" data-form="category"><input name="name" maxlength="40" placeholder="Nouvelle catégorie (ex. Boissons)" required>
        <button class="btn primary" type="submit">Ajouter</button></form>
    </div>`;
    const groups = groupByCategory(S.products);
    const prods = `<div class="card"><h2>Produits</h2>
      <div class="toolbar"><button class="btn primary" data-action="go" data-to="admin/produit/new">+ Nouveau produit</button>
        <button class="btn" data-action="load-catalogue">Charger le catalogue Challenge Lamouret</button></div>
      ${groups.map(g => `<h3>${esc(g.name)}</h3>${g.products.map(p => {
        const m = L.productMargin(p, ib);
        const off = p.active === false;
        return `<div class="lrow ${off ? 'off' : ''}">
          <div class="grow"><b>${esc(p.name)}</b>${off ? ' <span class="tag">Désactivé</span>' : ''}
            <div class="muted">${L.isMenu(p) ? `Menu : ${p.menu.map(st => esc(st.label)).join(' + ')}` : p.recipe && p.recipe.length ? `Recette : ${p.recipe.length} ingrédient(s)` : 'Pas de recette'}${showCost && m
              ? ` · Coût ${money(m.cost)}${m.complete ? '' : ' (incomplet)'} · Marge ${money(m.margin)} (${L.formatPct(m.pct)})` : ''}</div></div>
          <b class="price">${money(p.price)}</b>
          <button class="btn sm" data-action="go" data-to="admin/produit/${p.id}">Modifier</button>
        </div>`;
      }).join('')}`).join('') || '<p class="muted">Aucun produit.</p>'}
    </div>`;
    return cats + prods;
  }

  function recipeRow(item) {
    return `<div class="rrow">
      <select name="r_ing" aria-label="Ingrédient"><option value="">— Ingrédient —</option>
        ${S.ingredients.map(i => `<option value="${i.id}" ${item && item.ingredientId === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)})</option>`).join('')}
      </select>
      <input name="r_qty" inputmode="decimal" autocomplete="off" placeholder="Qté" aria-label="Quantité" value="${item ? L.formatQty(item.qty) : ''}">
      <button type="button" class="btn sm danger" data-action="recipe-remove" aria-label="Retirer">✕</button>
    </div>`;
  }

  function menuStep(step) {
    const sel = new Set(step ? step.options : []);
    const choices = groupByCategory(S.products.filter(x => !L.isMenu(x)));
    return `<div class="mstep">
      <div class="mhead"><input class="mlabel" maxlength="30" placeholder="Nom de l'étape (ex. Boisson)" value="${esc(step ? step.label : '')}" aria-label="Nom de l'étape">
        <button type="button" class="btn sm danger" data-action="mstep-remove" aria-label="Supprimer l'étape">✕</button></div>
      <div class="mopts">${choices.map(g => `<div class="mgroup"><b>${esc(g.name)}</b>
        ${g.products.map(o => `<label class="check"><input type="checkbox" value="${o.id}" ${sel.has(o.id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('')}</div>`).join('')}</div>
    </div>`;
  }

  function viewProductForm(id) {
    const p = id === 'new' ? null : S.products.find(x => x.id === id);
    if (id !== 'new' && !p) return '<p>Produit introuvable.</p>';
    const menu = L.isMenu(p);
    return `<form class="form card" data-form="product" data-id="${p ? p.id : ''}">
      <h2>${p ? 'Modifier le produit' : 'Nouveau produit'}</h2>
      <label>Nom *<input name="name" required maxlength="40" value="${esc(p ? p.name : '')}" placeholder="ex. Sandwich jambon"></label>
      <div class="two">
        <label>Prix de vente (€) *<input name="price" required inputmode="decimal" autocomplete="off" value="${p ? esc(L.formatEuros(p.price).replace(/\s?€/, '')) : ''}" placeholder="ex. 5,00"></label>
        <label>Catégorie<select name="categoryId">
          <option value="">— Aucune (Autres) —</option>
          ${S.categories.map(c => `<option value="${c.id}" ${p && p.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></label>
      </div>
      <label class="check"><input type="checkbox" name="active" ${!p || p.active !== false ? 'checked' : ''}> Produit actif (visible en caisse)</label>
      <label>Type<select name="ptype" data-change="ptype">
        <option value="simple">Produit simple</option>
        <option value="menu" ${menu ? 'selected' : ''}>Menu (le client choisit à chaque étape)</option>
      </select></label>
      <fieldset id="menu-steps" ${menu ? '' : 'hidden'}><legend>Étapes du menu</legend>
        <p class="muted">À la caisse, on choisit une option par étape (ex. Sandwich, puis Boisson, puis Crêpe). Les quantités et ingrédients des choix sont comptés automatiquement.</p>
        <div id="msteps">${(menu ? p.menu : []).map(menuStep).join('')}</div>
        <button type="button" class="btn sm" data-action="mstep-add">+ Ajouter une étape</button>
      </fieldset>
      <fieldset><legend>Recette / composition (facultatif)</legend>
        <p class="muted" id="menu-recipe-note" ${menu ? '' : 'hidden'}>Pour un menu : seulement ce qui est fixe (ex. 1 sachet de chips).</p>
        ${S.ingredients.length ? `<p class="muted">Quantité d'ingrédient utilisée pour UN produit vendu, dans l'unité de l'ingrédient.</p>
          <div id="recipe">${(p && p.recipe || []).map(recipeRow).join('')}</div>
          <button type="button" class="btn sm" data-action="recipe-add">+ Ajouter un ingrédient</button>`
        : '<p class="muted">Créez d\'abord des ingrédients (onglet Ingrédients) pour définir une recette.</p>'}
        <p id="cost-preview" class="costp"></p>
      </fieldset>
      <div class="actions">
        <button class="btn primary" type="submit">Enregistrer</button>
        <button class="btn" type="button" data-action="go" data-to="admin/produits">Annuler</button>
        ${p ? `<button class="btn danger" type="button" data-action="delete-product" data-id="${p.id}">Supprimer</button>` : ''}
      </div>
    </form>`;
  }

  function readRecipe(fd) {
    const ings = fd.getAll('r_ing'), qtys = fd.getAll('r_qty');
    const map = new Map();
    ings.forEach((id, k) => {
      if (!id) return;
      const q = L.parseDecimal(qtys[k]);
      const ing = S.ingredients.find(i => i.id === id);
      if (q == null || Number.isNaN(q) || q <= 0) throw new Error(`Quantité invalide pour « ${ing ? ing.name : '?'} » dans la recette.`);
      map.set(id, L.roundQty((map.get(id) || 0) + q));
    });
    return [...map].map(([ingredientId, qty]) => ({ ingredientId, qty }));
  }

  function updateCostPreview(form) {
    const out = form.querySelector('#cost-preview');
    if (!out) return;
    let recipe;
    try { recipe = readRecipe(new FormData(form)); } catch (_) { out.textContent = ''; return; }
    const price = L.parseEuros(form.elements.price.value);
    const m = L.productMargin({ price: Number.isInteger(price) ? price : 0, recipe }, L.indexById(S.ingredients));
    if (!m || (!m.complete && m.cost === 0)) { out.textContent = ''; return; }
    out.innerHTML = `Coût de revient : <b>${money(m.cost)}</b>${m.complete ? '' : ` <span class="muted">(incomplet : prix manquant pour ${esc(m.missing.join(', '))})</span>`}`
      + (Number.isInteger(price) && price > 0 ? ` · Marge brute : <b>${money(m.margin)}</b> (${L.formatPct(m.pct)})` : '');
  }

  async function saveProduct(f, fd) {
    const name = String(fd.get('name') || '').trim();
    if (!name) throw new Error('Le nom est obligatoire.');
    const price = L.parseEuros(fd.get('price'));
    if (price == null || Number.isNaN(price)) throw new Error('Prix de vente invalide (ex. 5 ou 2,50).');
    const recipe = readRecipe(fd);
    let menu = null;
    if (fd.get('ptype') === 'menu') {
      menu = [...f.querySelectorAll('.mstep')].map(el => ({
        label: el.querySelector('.mlabel').value.trim(),
        options: [...el.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value)
      }));
      if (!menu.length) throw new Error('Ajoutez au moins une étape au menu.');
      for (const st of menu) {
        if (!st.label) throw new Error('Chaque étape du menu doit avoir un nom.');
        if (!st.options.length) throw new Error(`Cochez au moins un choix pour l'étape « ${st.label} ».`);
      }
    }
    const old = f.dataset.id ? S.products.find(p => p.id === f.dataset.id) : null;
    const data = { name, price, categoryId: fd.get('categoryId') || null, active: !!fd.get('active'), recipe, menu };
    await DB.put('products', old ? { ...old, ...data } : { id: L.uuid(), order: Date.now(), ...data });
    await loadAll();
    toast('Produit enregistré.');
    go('admin/produits');
  }

  // ---------- Ingrédients ----------

  function viewIngredients() {
    const cur = currentEvent();
    const usage = id => S.products.filter(p => (p.recipe || []).some(r => r.ingredientId === id)).length;
    return `<div class="toolbar"><button class="btn primary" data-action="go" data-to="admin/ingredient/new">+ Nouvel ingrédient</button></div>
      ${cur && S.ingredients.length ? `<p class="note">Le stock initial se saisit par événement :
        <button class="link" data-action="go" data-to="admin/evenement/${cur.id}">saisir le stock initial de « ${esc(cur.name)} »</button></p>` : ''}
      <div class="card">${S.ingredients.map(i => {
        const uc = L.ingredientUnitCost(i), n = usage(i.id);
        return `<div class="lrow"><div class="grow"><b>${esc(i.name)}</b> <span class="muted">(${esc(i.unit)})</span>
          <div class="muted">${uc != null ? `${L.formatEurosPrecise(uc)} / ${esc(i.unit)}` : "Prix d'achat non renseigné"} · utilisé dans ${n} produit(s)</div></div>
          <button class="btn sm" data-action="go" data-to="admin/ingredient/${i.id}">Modifier</button></div>`;
      }).join('') || '<p class="muted">Aucun ingrédient. Les ingrédients servent à calculer la consommation théorique et le coût de revient.</p>'}</div>`;
  }

  function viewIngredientForm(id) {
    const i = id === 'new' ? null : S.ingredients.find(x => x.id === id);
    if (id !== 'new' && !i) return '<p>Ingrédient introuvable.</p>';
    return `<form class="form card" data-form="ingredient" data-id="${i ? i.id : ''}">
      <h2>${i ? "Modifier l'ingrédient" : 'Nouvel ingrédient'}</h2>
      <label>Nom *<input name="name" required maxlength="40" value="${esc(i ? i.name : '')}" placeholder="ex. Jambon"></label>
      <label>Unité *<input name="unit" required maxlength="20" list="units" autocomplete="off" value="${esc(i ? i.unit : '')}" placeholder="ex. tranche, g, portion, unité…"></label>
      <datalist id="units">${UNITS.map(u => `<option value="${u}">`).join('')}</datalist>
      <fieldset><legend>Prix d'achat (facultatif, pour le coût de revient)</legend>
        <div class="two">
          <label>Prix payé (€)<input name="purchasePrice" inputmode="decimal" autocomplete="off" value="${i && i.purchasePrice != null ? esc(L.formatEuros(i.purchasePrice).replace(/\s?€/, '')) : ''}" placeholder="ex. 1,50"></label>
          <label>Pour une quantité de<input name="purchaseQty" inputmode="decimal" autocomplete="off" value="${i && i.purchaseQty != null ? L.formatQty(i.purchaseQty) : ''}" placeholder="ex. 6"></label>
        </div>
        <p id="unit-cost" class="costp"></p>
      </fieldset>
      <div class="actions">
        <button class="btn primary" type="submit">Enregistrer</button>
        <button class="btn" type="button" data-action="go" data-to="admin/ingredients">Annuler</button>
        ${i ? `<button class="btn danger" type="button" data-action="delete-ingredient" data-id="${i.id}">Supprimer</button>` : ''}
      </div>
    </form>`;
  }

  function updateUnitCost(form) {
    const out = form.querySelector('#unit-cost');
    if (!out) return;
    const price = L.parseEuros(form.elements.purchasePrice.value);
    const qty = L.parseDecimal(form.elements.purchaseQty.value);
    const unit = form.elements.unit.value.trim() || 'unité';
    const uc = L.ingredientUnitCost({ purchasePrice: Number.isInteger(price) ? price : null, purchaseQty: qty > 0 ? qty : null });
    out.innerHTML = uc != null ? `Coût unitaire : <b>${L.formatEurosPrecise(uc)} / ${esc(unit)}</b>` : '';
  }

  async function saveIngredient(f, fd) {
    const name = String(fd.get('name') || '').trim();
    const unit = String(fd.get('unit') || '').trim();
    if (!name) throw new Error('Le nom est obligatoire.');
    if (!unit) throw new Error("L'unité est obligatoire.");
    const purchasePrice = L.parseEuros(fd.get('purchasePrice'));
    const purchaseQty = L.parseDecimal(fd.get('purchaseQty'));
    if (Number.isNaN(purchasePrice)) throw new Error("Prix d'achat invalide.");
    if (Number.isNaN(purchaseQty) || purchaseQty === 0) throw new Error('Quantité achetée invalide.');
    const old = f.dataset.id ? S.ingredients.find(i => i.id === f.dataset.id) : null;
    const data = { name, unit, purchasePrice, purchaseQty };
    await DB.put('ingredients', old ? { ...old, ...data } : { id: L.uuid(), ...data });
    await loadAll();
    toast('Ingrédient enregistré.');
    go('admin/ingredients');
  }

  // ---------- Historique & bilan ----------

  async function viewHistory(eventId) {
    const ev = pickEvent(eventId);
    if (!ev) return noEvent;
    const sales = (await DB.salesByEvent(ev.id)).sort(byNumberDesc);
    const cancelled = sales.filter(L.isCancelled).length;
    return `${eventSelect(ev, 'historique')}
      <p class="muted">${sales.length - cancelled} vente(s) valide(s) · ${cancelled} annulée(s)</p>
      ${salesList(sales, 'admin/vente', true)}`;
  }

  async function viewBilan(eventId) {
    const ev = pickEvent(eventId);
    if (!ev) return noEvent;
    const [sales, answers] = await Promise.all([DB.salesByEvent(ev.id), DB.answersByEvent(ev.id)]);
    const st = L.computeStats({ sales, products: S.products, ingredients: S.ingredients, initialStock: ev.initialStock, answers });
    const nAns = st.survey.yes + st.survey.no;
    const ings = st.ingredients.filter(r => r.consumed > 0 || r.initialStock != null);
    const kpi = (k, v, sub) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="muted">${sub}</div>` : ''}</div>`;
    return `${eventSelect(ev, 'bilan')}
      <div class="kpis">
        ${kpi("Chiffre d'affaires", money(st.revenue))}
        ${kpi('Ventes', st.salesCount, `${st.cancelledCount} annulée(s) exclue(s)`)}
        ${kpi('Espèces', money(st.payments.especes.amount), `${st.payments.especes.count} vente(s)`)}
        ${kpi('Carte', money(st.payments.carte.amount), `${st.payments.carte.count} vente(s)`)}
        ${kpi('Panier moyen', money(st.average))}
        ${st.hasCostData ? kpi('Marge brute estimée', money(st.margin), `coût ingrédients ${money(st.ingredientCost)}`) : ''}
      </div>
      <div class="toolbar"><button class="btn primary" data-action="export-xlsx" data-id="${ev.id}">EXPORTER vers Excel</button></div>
      ${st.days.length > 1 ? `<div class="card"><h2>Par jour</h2><div class="tscroll"><table class="t">
        <tr><th>Jour</th><th class="n">Ventes</th><th class="n">Espèces</th><th class="n">Carte</th><th class="n">CA</th></tr>
        ${st.days.map(d => `<tr><td>${L.formatDayLabel(d.day)}</td><td class="n">${d.count}</td><td class="n">${money(d.especes || 0)}</td><td class="n">${money(d.carte || 0)}</td><td class="n">${money(d.revenue)}</td></tr>`).join('')}
      </table></div></div>` : ''}
      ${ev.surveyQuestion || nAns || st.survey.already ? `<div class="card"><h2>Sondage</h2><p>${esc(ev.surveyQuestion || '')}</p><table class="t">
        <tr><td>OUI</td><td class="n">${st.survey.yes}</td><td class="n">${nAns ? L.formatPct(st.survey.yes / nAns) : '—'}</td></tr>
        <tr><td>NON</td><td class="n">${st.survey.no}</td><td class="n">${nAns ? L.formatPct(st.survey.no / nAns) : '—'}</td></tr>
        <tr><td>Déjà posée (client revenu)</td><td class="n">${st.survey.already}</td><td></td></tr>
      </table><p class="muted">Pourcentages calculés sur les OUI + NON.</p></div>` : ''}
      <div class="card"><h2>Produits vendus</h2>${st.products.length ? `<div class="tscroll"><table class="t">
        <tr><th>Produit</th><th class="n">Total servi</th><th class="n">dont menus</th><th class="n">CA</th></tr>
        ${st.products.map(p => `<tr><td>${esc(p.name)}</td><td class="n">${p.total}</td><td class="n">${p.inMenu || ''}</td><td class="n">${p.revenue ? money(p.revenue) : ''}</td></tr>`).join('')}
      </table></div><p class="muted">« Total servi » compte aussi les produits choisis dans les menus ; leur CA est compté sur la ligne du menu.</p>`
      : '<p class="muted">Aucune vente.</p>'}</div>
      <div class="card"><h2>Consommation théorique des ingrédients</h2>${ings.length ? `<div class="tscroll"><table class="t">
        <tr><th>Ingrédient</th><th class="n">Consommé</th><th class="n">Stock initial</th><th class="n">Reste théorique</th></tr>
        ${ings.map(r => `<tr><td>${esc(r.name)}</td><td class="n">${L.formatQty(r.consumed)} ${esc(r.unit)}</td>
          <td class="n">${r.initialStock != null ? L.formatQty(r.initialStock) : '—'}</td>
          <td class="n ${r.remaining != null && r.remaining < 0 ? 'neg' : ''}">${r.remaining != null ? L.formatQty(r.remaining) : '—'}</td></tr>`).join('')}
      </table></div><p class="muted">Calculé à partir des recettes actuelles et des ventes valides.</p>`
      : '<p class="muted">Aucune consommation (pas de recette ou pas de vente).</p>'}</div>`;
  }

  // ---------- Export, sauvegarde, restauration ----------

  async function viewData(eventId) {
    const ev = pickEvent(eventId);
    let persisted = null;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (_) { /* non supporté */ }
    const last = S.settings.lastBackupAt;
    return `<div class="card"><h2>Exporter vers Excel</h2>
        <p class="muted">Fichier .xlsx avec les feuilles Bilan, Ventes, Lignes de vente, Produits et Ingrédients.</p>
        ${ev ? `${eventSelect(ev, 'donnees')}
        <div class="actions"><button class="btn primary" data-action="export-xlsx" data-id="${ev.id}">EXPORTER</button></div>` : noEvent}
      </div>
      <div class="card"><h2>Sauvegarde</h2>
        <p>Un fichier contenant <b>toutes</b> les données (événements, produits, ingrédients, ventes). Gardez-le en lieu sûr (e-mail, clé USB, PC) pour pouvoir tout restaurer si le téléphone est perdu ou réinitialisé.</p>
        <p class="muted">Dernière sauvegarde depuis cet appareil : ${last ? `${L.formatDate(last)} à ${L.formatTime(last)}` : 'jamais'}</p>
        <div class="actions"><button class="btn primary" data-action="backup">EXPORTER LA SAUVEGARDE</button></div>
      </div>
      <div class="card"><h2>Restaurer une sauvegarde</h2>
        <p>Remplace <b>toutes</b> les données de cet appareil par celles du fichier.</p>
        <label class="btn file">IMPORTER UNE SAUVEGARDE<input type="file" accept=".json,application/json" data-change="import" hidden></label>
      </div>
      <div class="card"><h2>Remise à zéro</h2>
        <p>Efface définitivement toutes les données de cet appareil.</p>
        <button class="btn danger" data-action="reset">Tout effacer</button>
      </div>
      <p class="muted">Stockage ${persisted === true ? 'persistant : le navigateur ne supprimera pas les données de lui-même.' : persisted === false ? 'non garanti : installez l\'application sur l\'écran d\'accueil et faites des sauvegardes régulières.' : 'local.'}</p>`;
  }

  async function exportXlsx(eventId) {
    const ev = eventById(eventId);
    if (!ev) return;
    const now = new Date();
    const sheets = L.buildExportSheets({
      event: ev, sales: await DB.salesByEvent(ev.id), answers: await DB.answersByEvent(ev.id), products: S.products,
      categories: S.categories, ingredients: S.ingredients, now
    });
    download(`caisse_${L.slug(ev.name)}_${L.fileStamp(now)}.xlsx`,
      new Blob([X.build(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    toast('Fichier Excel exporté (dossier Téléchargements).');
  }

  async function exportBackup() {
    const data = await DB.exportAll();
    download(`sauvegarde-caisse_${L.fileStamp(new Date())}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
    await DB.setSetting('lastBackupAt', data.exportedAt);
    await loadAll();
    toast('Sauvegarde exportée (dossier Téléchargements).');
    render();
  }

  async function importBackup(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    let backup, info;
    try {
      backup = JSON.parse(await file.text());
      info = DB.checkBackup(backup);
    } catch (e) {
      return toast('Import impossible : ' + (e instanceof SyntaxError ? 'fichier illisible.' : e.message), 'err', 6000);
    }
    const when = info.exportedAt ? `${L.formatDate(info.exportedAt)} à ${L.formatTime(info.exportedAt)}` : 'date inconnue';
    if (!confirm(`Restaurer la sauvegarde du ${when} ?\n(${info.events} événement(s), ${info.products} produit(s), ${info.sales} vente(s))\n\nATTENTION : toutes les données actuelles de cet appareil seront REMPLACÉES.`)) return;
    await DB.importAll(backup);
    await loadAll();
    setCart([]);
    toast('Sauvegarde restaurée.', 'ok', 4000);
    go('admin/evenements');
  }

  async function resetAll() {
    if (!confirm('Effacer TOUTES les données (événements, produits, ingrédients, ventes) ?\n\nConseil : exportez d\'abord une sauvegarde.')) return;
    const typed = prompt('Pour confirmer, tapez EFFACER :');
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== 'EFFACER') return toast('Remise à zéro annulée.', 'err');
    await DB.clearAll();
    await loadAll();
    setCart([]);
    toast('Toutes les données ont été effacées.');
    go('admin/evenements');
  }

  // ---------- Code PIN ----------

  function viewSettings() {
    const has = !!S.settings.pin;
    return `<form class="form card" data-form="pin">
      <h2>Code PIN de l'administration</h2>
      <p>${has ? 'Un code est actif : il est demandé pour ouvrir l\'administration depuis la caisse.'
               : "Aucun code : n'importe qui peut ouvrir l'administration depuis la caisse."}</p>
      <div class="two">
        <label>${has ? 'Nouveau code' : 'Code'} (4 à 8 chiffres)<input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" required></label>
        <label>Confirmer le code<input name="pin2" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" required></label>
      </div>
      <p class="muted">Notez-le : en cas d'oubli, il faudra effacer les données du navigateur puis restaurer une sauvegarde.</p>
      <div class="actions"><button class="btn primary" type="submit">Enregistrer le code</button>
        ${has ? '<button class="btn danger" type="button" data-action="pin-remove">Supprimer le code</button>' : ''}</div>
    </form>`;
  }

  async function savePin(f, fd) {
    const pin = String(fd.get('pin') || '').trim();
    if (!/^\d{4,8}$/.test(pin)) throw new Error('Le code doit contenir 4 à 8 chiffres.');
    if (pin !== String(fd.get('pin2') || '').trim()) throw new Error('Les deux codes ne correspondent pas.');
    await DB.setSetting('pin', pin);
    await loadAll();
    toast('Code PIN enregistré.');
    render();
  }

  // ==========================================================================
  // Actions (boutons) et formulaires
  // ==========================================================================

  const actions = {
    go: el => go(el.dataset.to),

    // Caisse
    add: el => {
      const p = S.products.find(x => x.id === el.dataset.id);
      if (!p || S.saving) return;
      if (L.isMenu(p)) {
        S.menuPick = { product: p, step: 0, choices: [] };
        return advanceMenu();
      }
      addToCart(p);
    },
    pick: el => {
      const mp = S.menuPick, p = S.products.find(x => x.id === el.dataset.id);
      if (!mp || !p) return;
      mp.choices.push({ step: mp.product.menu[mp.step].label, stepIndex: mp.step, productId: p.id, name: p.name });
      mp.step++;
      advanceMenu();
    },
    'pick-back': () => {
      const mp = S.menuPick;
      if (!mp) return;
      if (!mp.choices.length) { S.menuPick = null; return updateProducts(); }
      mp.step = mp.choices.pop().stepIndex;
      updateProducts();
    },
    'pick-cancel': () => { S.menuPick = null; updateProducts(); },
    survey: el => { if (S.cart.length && !S.saving) { S.survey = el.dataset.answer; updateCart(); } },
    inc: el => { if (!S.saving) setCart(L.cartChange(S.cart, el.dataset.id, +1)); },
    dec: el => { if (!S.saving) setCart(L.cartChange(S.cart, el.dataset.id, -1)); },
    'clear-cart': () => { if (!S.saving) setCart([]); },
    pay: el => { S.payment = el.dataset.pay; updateCart(); },
    validate: validateSale,
    'cancel-sale': el => cancelSale(el.dataset.id),
    'correct-sale': el => correctSale(el.dataset.id),

    // PIN
    'pin-key': el => { if (S.pinEntry.length < 8) { S.pinEntry += el.dataset.k; pinUpdate(false); } },
    'pin-del': () => { S.pinEntry = S.pinEntry.slice(0, -1); pinUpdate(false); },
    'pin-ok': () => pinUpdate(true),
    'pin-remove': async () => {
      if (!confirm('Supprimer le code PIN ? L\'administration sera accessible sans code.')) return;
      await DB.setSetting('pin', null);
      await loadAll();
      toast('Code PIN supprimé.');
      render();
    },

    // Événements
    'use-event': async el => {
      await DB.setSetting('currentEventId', el.dataset.id);
      await loadAll();
      setCart([]);
      toast(`« ${eventById(el.dataset.id).name} » est ouvert en caisse.`);
      render();
    },
    'archive-event': async el => {
      const ev = eventById(el.dataset.id);
      if (!confirm(`Archiver « ${ev.name} » ?\n\nIl passera en lecture seule (bilan et historique consultables, plus de ventes possibles). Vous pourrez le réactiver.`)) return;
      await DB.put('events', { ...ev, archived: true });
      if (S.settings.currentEventId === ev.id) await DB.setSetting('currentEventId', null);
      await loadAll();
      render();
    },
    'unarchive-event': async el => {
      await DB.put('events', { ...eventById(el.dataset.id), archived: false });
      await loadAll();
      render();
    },
    'delete-event': async el => {
      const ev = eventById(el.dataset.id);
      const n = await DB.countSalesByEvent(ev.id);
      if (!confirm(`Supprimer définitivement « ${ev.name} »${n ? ` et ses ${n} vente(s)` : ''} ?\n\nCette action est irréversible.`)) return;
      if (n) {
        const typed = prompt(`Cet événement contient ${n} vente(s).\nPour confirmer la suppression, tapez SUPPRIMER :`);
        if (typed === null || typed.trim().toUpperCase() !== 'SUPPRIMER') return toast('Suppression annulée.', 'err');
      }
      await DB.deleteEvent(ev.id);
      if (S.settings.currentEventId === ev.id) await DB.setSetting('currentEventId', null);
      await loadAll();
      toast('Événement supprimé.');
      render();
    },

    // Catégories
    'cat-move': async el => {
      const i = S.categories.findIndex(c => c.id === el.dataset.id);
      const j = i + Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= S.categories.length) return;
      const list = [...S.categories];
      [list[i], list[j]] = [list[j], list[i]];
      await DB.putMany('categories', list.map((c, k) => ({ ...c, order: k })));
      await loadAll();
      render();
    },
    'cat-rename': async el => {
      const c = S.categories.find(x => x.id === el.dataset.id);
      const name = prompt('Nouveau nom de la catégorie :', c.name);
      if (name === null || !name.trim()) return;
      await DB.put('categories', { ...c, name: name.trim().slice(0, 40) });
      await loadAll();
      render();
    },
    'cat-delete': async el => {
      const c = S.categories.find(x => x.id === el.dataset.id);
      const n = S.products.filter(p => p.categoryId === c.id).length;
      if (n) return alert(`La catégorie « ${c.name} » contient ${n} produit(s). Déplacez-les d'abord dans une autre catégorie.`);
      if (!confirm(`Supprimer la catégorie « ${c.name} » ?`)) return;
      await DB.del('categories', c.id);
      await loadAll();
      render();
    },

    // Produits
    'load-catalogue': async () => {
      if (!confirm('Ajouter le catalogue du Challenge Lamouret ?\n(produits et prix, menu, recettes des sandwichs, ingrédients, événement)\n\nLes éléments qui existent déjà (même nom) ne sont pas modifiés.')) return;
      const n = await applyCatalogue();
      toast(n ? `Catalogue chargé : ${n} élément(s) ajouté(s).` : 'Le catalogue est déjà complet.');
      render();
    },
    'mstep-add': () => document.getElementById('msteps').insertAdjacentHTML('beforeend', menuStep(null)),
    'mstep-remove': el => el.closest('.mstep').remove(),
    'recipe-add': () => {
      document.getElementById('recipe').insertAdjacentHTML('beforeend', recipeRow(null));
      const sel = document.querySelectorAll('#recipe select');
      sel[sel.length - 1].focus();
    },
    'recipe-remove': el => {
      const form = el.closest('form');
      el.closest('.rrow').remove();
      updateCostPreview(form);
    },
    'delete-product': async el => {
      const p = S.products.find(x => x.id === el.dataset.id);
      if (await DB.isProductSold(p.id)) {
        return alert(`« ${p.name} » a déjà été vendu : il ne peut pas être supprimé (l'historique doit rester complet).\n\nDécochez « Produit actif » pour le retirer de la caisse.`);
      }
      if (!confirm(`Supprimer définitivement le produit « ${p.name} » ?`)) return;
      await DB.del('products', p.id);
      setCart(S.cart.filter(l => l.productId !== p.id));
      await loadAll();
      toast('Produit supprimé.');
      go('admin/produits');
    },

    // Ingrédients
    'delete-ingredient': async el => {
      const i = S.ingredients.find(x => x.id === el.dataset.id);
      const users = S.products.filter(p => (p.recipe || []).some(r => r.ingredientId === i.id));
      if (users.length) return alert(`« ${i.name} » est utilisé dans la recette de : ${users.map(p => p.name).join(', ')}.\n\nRetirez-le d'abord de ces recettes.`);
      if (!confirm(`Supprimer l'ingrédient « ${i.name} » ?`)) return;
      await DB.del('ingredients', i.id);
      await loadAll();
      toast('Ingrédient supprimé.');
      go('admin/ingredients');
    },

    // Données
    'export-xlsx': el => exportXlsx(el.dataset.id),
    backup: exportBackup,
    reset: resetAll
  };

  const forms = {
    event: saveEvent,
    product: saveProduct,
    ingredient: saveIngredient,
    pin: savePin,
    category: async (f, fd) => {
      const name = String(fd.get('name') || '').trim();
      if (!name) return;
      const order = S.categories.reduce((m, c) => Math.max(m, c.order), -1) + 1;
      await DB.put('categories', { id: L.uuid(), name, order });
      await loadAll();
      render();
    }
  };

  function showError(e) {
    console.error(e);
    toast('Erreur : ' + (e && e.message ? e.message : e), 'err', 6000);
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    Promise.resolve().then(() => fn(el)).catch(showError);
  });

  document.addEventListener('submit', async e => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    if (f.dataset.busy) return;
    f.dataset.busy = '1';
    try { await forms[f.dataset.form](f, new FormData(f)); } catch (err) { showError(err); } finally { delete f.dataset.busy; }
  });

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.change === 'event-select') go(`admin/${t.dataset.tab}/${t.value}`);
    else if (t.dataset.change === 'ptype') {
      const menu = t.value === 'menu';
      document.getElementById('menu-steps').hidden = !menu;
      document.getElementById('menu-recipe-note').hidden = !menu;
      if (menu && !document.querySelector('#msteps .mstep')) actions['mstep-add']();
    }
    else if (t.dataset.change === 'import') importBackup(t).catch(showError);
  });

  document.addEventListener('input', e => {
    const f = e.target.closest('form[data-form]');
    if (f && f.dataset.form === 'product') updateCostPreview(f);
    if (f && f.dataset.form === 'ingredient') updateUnitCost(f);
  });
  document.addEventListener('change', e => {
    const f = e.target.closest('form[data-form="product"]');
    if (f) updateCostPreview(f);
  });

  // Saisie du PIN au clavier (PC)
  document.addEventListener('keydown', e => {
    if (!document.getElementById('pindots')) return;
    if (/^\d$/.test(e.key)) actions['pin-key']({ dataset: { k: e.key } });
    else if (e.key === 'Backspace') actions['pin-del']();
    else if (e.key === 'Enter') actions['pin-ok']();
  });

  // Après rendu d'un formulaire, afficher les coûts calculés
  new MutationObserver(() => {
    const pf = document.querySelector('form[data-form="product"]');
    if (pf) updateCostPreview(pf);
    const inf = document.querySelector('form[data-form="ingredient"]');
    if (inf) updateUnitCost(inf);
  }).observe(app, { childList: true });

  window.addEventListener('hashchange', render);
  window.addEventListener('error', e => toast('Erreur : ' + e.message, 'err', 6000));
  window.addEventListener('unhandledrejection', e => showError(e.reason));

  // ---------- Démarrage ----------

  /** Ajoute le catalogue Challenge Lamouret (sans rien écraser). Renvoie le nombre d'éléments ajoutés. */
  async function applyCatalogue() {
    const add = window.Catalogue.build({ events: S.events, categories: S.categories, products: S.products, ingredients: S.ingredients });
    const n = add.events.length + add.categories.length + add.products.length + add.ingredients.length;
    if (n) await DB.putRecords(add);
    if (add.events.length && !currentEvent()) await DB.setSetting('currentEventId', add.events[0].id);
    await loadAll();
    return n;
  }

  async function start() {
    try {
      await DB.open();
      await loadAll();
      if (!S.settings.deviceId) {
        await DB.setSetting('deviceId', L.uuid());
        await loadAll();
      }
      for (const e of S.events) {
        if (window.Catalogue.OLD_QUESTIONS.includes(e.surveyQuestion)) {
          await DB.put('events', { ...e, surveyQuestion: window.Catalogue.EVENT.surveyQuestion });
          await loadAll();
        }
      }
      // Premier lancement (base vide) : la buvette est prête à l'emploi.
      if (!S.events.length && !S.categories.length && !S.products.length && !S.ingredients.length) await applyCatalogue();
    } catch (e) {
      app.innerHTML = `<div class="page"><h1>Stockage indisponible</h1><p class="error">${esc(e.message)}</p>
        <p>Vérifiez que vous n'êtes pas en navigation privée, puis rechargez la page.</p></div>`;
      return;
    }
    // Demande au navigateur de ne jamais effacer les données automatiquement.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker :', err));
      // Nouvelle version de l'application installée : on recharge si rien n'est en cours.
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (!S.cart.length && !S.saving && !document.querySelector('form[data-form]:not([data-form=category])')) location.reload();
        else toast("Nouvelle version installée : elle sera active à la prochaine ouverture de l'application.", 'ok', 6000);
      });
    }
    render();
  }

  start();
})();
