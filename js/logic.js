/*
 * Logique métier pure : panier, ventes, statistiques, recettes, coûts, export.
 * Aucun accès au DOM ni au stockage : ce fichier est testé directement avec Node.
 *
 * Convention : tous les montants sont stockés en CENTIMES (entiers) pour éviter
 * les erreurs d'arrondi (0,1 + 0,2 ≠ 0,3 en JavaScript). Les coûts unitaires
 * d'ingrédients peuvent être des fractions de centime (ex. 0,6 c€ la portion).
 */
(function (root, factory) {
  const L = factory();
  if (typeof module === 'object' && module.exports) module.exports = L;
  else root.Logic = L;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PAYMENTS = { especes: 'Espèces', carte: 'Carte' };
  // Réponses au sondage, posé avant la validation de chaque vente
  const SURVEY = { oui: 'Oui', non: 'Non', deja: 'Déjà posée' };
  const CANCELLED = 'annulee';
  const VALID = 'valide';
  const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

  // ---------- Utilitaires ----------

  function uuid() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // randomUUID n'existe pas hors contexte sécurisé (ex. http:// sur le réseau local)
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function indexById(list) {
    const m = Object.create(null);
    for (const x of list || []) m[x.id] = x;
    return m;
  }

  const roundQty = x => Math.round(x * 1e6) / 1e6;
  const pad = n => String(n).padStart(2, '0');

  /** "5,50" / "5.5" / "5 €" → 5.5 ; "" → null ; texte invalide → NaN. Pas de négatif. */
  function parseDecimal(input) {
    if (input == null) return null;
    if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : NaN;
    const s = String(input).replace(/[\s  €]/g, '').replace(',', '.');
    if (s === '') return null;
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }

  /** Saisie en euros → centimes entiers (null si vide, NaN si invalide). */
  function parseEuros(input) {
    const n = parseDecimal(input);
    if (n === null || Number.isNaN(n)) return n;
    return Math.round(Number((n * 100).toPrecision(12)));
  }

  /** 1250 → "12,50 €" */
  function formatEuros(cents) {
    if (cents == null || Number.isNaN(cents)) return '—';
    const neg = cents < 0;
    const abs = Math.round(Math.abs(cents));
    const ints = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (neg ? '-' : '') + ints + ',' + pad(abs % 100) + ' €';
  }

  /** Coût unitaire précis (fractions de centime) : 0.6 → "0,006 €" */
  function formatEurosPrecise(cents) {
    if (cents == null || Number.isNaN(cents)) return '—';
    let s = (cents / 100).toFixed(4).replace(/(\.\d\d\d*?)0+$/, '$1');
    return s.replace('.', ',') + ' €';
  }

  /** 0.5 → "0,5" ; 40 → "40" */
  function formatQty(n) {
    if (n == null || Number.isNaN(n)) return '—';
    return String(roundQty(Number(n.toFixed(3)))).replace('.', ',');
  }

  /** 0.656 → "65,6 %" */
  function formatPct(fraction) {
    if (fraction == null || !Number.isFinite(fraction)) return '—';
    return (Math.round(fraction * 1000) / 10).toFixed(1).replace('.', ',') + ' %';
  }

  function localDay(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function dayToDate(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function formatDate(isoOrDay) {
    if (!isoOrDay) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(isoOrDay) ? dayToDate(isoOrDay) : new Date(isoOrDay);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
  function formatTime(iso) {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function formatDayLabel(day) {
    return `${DAYS[dayToDate(day).getDay()]} ${formatDate(day)}`;
  }
  function formatPeriod(ev) {
    if (!ev) return '';
    const a = formatDate(ev.startDate), b = formatDate(ev.endDate);
    if (a && b && a !== b) return `du ${a} au ${b}`;
    return a || b || '';
  }
  /** Horodatage pour les noms de fichier : 2026-10-10_14h32 */
  function fileStamp(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
  }
  function slug(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'evenement';
  }

  // ---------- Panier ----------
  // Une ligne de panier : { key, productId, name, unitPrice (centimes), qty, choices? }
  // Pour un menu, `choices` = [{ step, productId, name }] (ex. sandwich, boisson, crêpe) :
  // deux menus avec des choix différents sont deux lignes distinctes.

  const isMenu = p => !!(p && Array.isArray(p.menu) && p.menu.length);

  function lineKey(productId, choices) {
    return choices && choices.length ? productId + '|' + choices.map(c => c.productId).join('|') : productId;
  }
  const keyOf = l => l.key || lineKey(l.productId, l.choices);

  function cartAdd(cart, product, choices) {
    const key = lineKey(product.id, choices);
    const i = cart.findIndex(l => keyOf(l) === key);
    if (i >= 0) return cart.map((l, k) => (k === i ? { ...l, qty: l.qty + 1 } : l));
    const line = { key, productId: product.id, name: product.name, unitPrice: product.price, qty: 1 };
    if (choices && choices.length) line.choices = choices.map(c => ({ step: c.step, productId: c.productId, name: c.name }));
    return [...cart, line];
  }

  function cartChange(cart, key, delta) {
    return cart
      .map(l => (keyOf(l) === key ? { ...l, qty: l.qty + delta } : l))
      .filter(l => l.qty > 0);
  }

  /** Ligne de vente → ligne de panier (pour corriger une vente). */
  const lineToCart = l => {
    const c = { key: lineKey(l.productId, l.choices), productId: l.productId, name: l.name, unitPrice: l.unitPrice, qty: l.qty };
    if (l.choices && l.choices.length) c.choices = l.choices;
    return c;
  };

  /** "Sandwich poulet + Orangina + Crêpe Nutella" */
  const choicesText = l => (l.choices || []).map(c => c.name).join(' + ');

  function cartTotal(cart) {
    return cart.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  }

  // ---------- Ventes ----------

  /**
   * Construit l'enregistrement d'une vente à partir du panier.
   * Le nom et le prix des produits sont copiés dans la vente : modifier un produit
   * plus tard ne change pas l'historique. Le numéro (#154) est attribué au moment
   * de l'enregistrement en base.
   */
  function buildSale({ id, eventId, cart, payment, now, deviceId, survey }) {
    if (survey != null && !SURVEY[survey]) throw new Error('Réponse au sondage invalide.');
    if (!eventId) throw new Error('Aucun événement ouvert.');
    if (!Array.isArray(cart) || cart.length === 0) throw new Error('Le panier est vide.');
    if (!PAYMENTS[payment]) throw new Error('Mode de paiement invalide.');
    const lines = cart.map(l => {
      if (!Number.isInteger(l.qty) || l.qty <= 0) throw new Error(`Quantité invalide pour ${l.name}.`);
      if (!Number.isInteger(l.unitPrice) || l.unitPrice < 0) throw new Error(`Prix invalide pour ${l.name}.`);
      const line = { productId: l.productId, name: l.name, unitPrice: l.unitPrice, qty: l.qty, total: l.unitPrice * l.qty };
      if (l.choices && l.choices.length) line.choices = l.choices.map(c => ({ step: c.step, productId: c.productId, name: c.name }));
      return line;
    });
    return {
      id: id || uuid(),
      eventId,
      number: null,
      createdAt: (now || new Date()).toISOString(),
      total: lines.reduce((s, l) => s + l.total, 0),
      payment,
      status: VALID,
      lines,
      deviceId: deviceId || null,
      cancelledAt: null,
      cancelReason: null,
      survey: survey || null
    };
  }

  /** Une vente annulée est conservée et marquée, jamais supprimée. */
  function cancelSale(sale, reason, now) {
    if (sale.status === CANCELLED) return sale;
    return {
      ...sale,
      status: CANCELLED,
      cancelledAt: (now || new Date()).toISOString(),
      cancelReason: (reason || '').trim() || null
    };
  }

  const isCancelled = s => s.status === CANCELLED;

  // ---------- Ingrédients, recettes, coûts ----------

  /** Coût d'une unité d'ingrédient en centimes (peut être fractionnaire), ou null. */
  function ingredientUnitCost(ing) {
    if (!ing || ing.purchasePrice == null || !ing.purchaseQty) return null;
    return ing.purchasePrice / ing.purchaseQty;
  }

  /**
   * Coût de revient d'un produit d'après sa recette.
   * → null si pas de recette ; sinon { cost, complete, missing[] }.
   * complete = false si un ingrédient de la recette n'a pas de prix d'achat.
   */
  function productCost(product, ingById) {
    // Le coût d'un menu dépend des choix du client : il est compté dans le bilan, pas ici.
    if (!product || isMenu(product) || !product.recipe || product.recipe.length === 0) return null;
    let cost = 0;
    const missing = [];
    for (const r of product.recipe) {
      const ing = ingById[r.ingredientId];
      const uc = ingredientUnitCost(ing);
      if (uc == null) missing.push(ing ? ing.name : '?');
      else cost += uc * r.qty;
    }
    return { cost, complete: missing.length === 0, missing };
  }

  function productMargin(product, ingById) {
    const pc = productCost(product, ingById);
    if (!pc) return null;
    const margin = product.price - pc.cost;
    return { ...pc, margin, pct: product.price > 0 ? margin / product.price : null };
  }

  /** Texte lisible d'une recette : "Jambon : 2 tranche ; Baguette : 0,5 unité" */
  function recipeText(product, ingById) {
    return (product.recipe || [])
      .map(r => {
        const ing = ingById[r.ingredientId];
        return ing ? `${ing.name} : ${formatQty(r.qty)} ${ing.unit}` : null;
      })
      .filter(Boolean)
      .join(' ; ');
  }

  // ---------- Statistiques ----------

  /** Composition d'un menu : "Sandwich : jambon, poulet ; Boisson : …" */
  function menuText(product, prodById) {
    if (!isMenu(product)) return '';
    return product.menu.map(s => `${s.label} : ${s.options.map(id => prodById[id] ? prodById[id].name : null).filter(Boolean).join(', ')}`).join(' ; ');
  }

  /**
   * Bilan d'un événement. Les ventes annulées sont exclues de tous les totaux.
   * Quantités : « vendu seul » + « dans les menus » = total réellement servi.
   * La consommation théorique d'ingrédients est calculée avec les recettes ACTUELLES
   * (ainsi, une recette saisie ou corrigée après coup est prise en compte), menus compris.
   */
  function computeStats({ sales, products, ingredients, initialStock, answers }) {
    const prodById = indexById(products);
    const ingById = indexById(ingredients);
    const stock = initialStock || {};
    const valid = (sales || []).filter(s => !isCancelled(s));

    let revenue = 0;
    const payments = {};
    for (const k of Object.keys(PAYMENTS)) payments[k] = { amount: 0, count: 0 };
    const perProduct = new Map();
    const perDay = new Map();

    for (const s of valid) {
      revenue += s.total;
      const p = payments[s.payment] || (payments[s.payment] = { amount: 0, count: 0 });
      p.amount += s.total;
      p.count += 1;

      const day = localDay(s.createdAt);
      const d = perDay.get(day) || { day, count: 0, revenue: 0, especes: 0, carte: 0 };
      d.count += 1;
      d.revenue += s.total;
      d[s.payment] = (d[s.payment] || 0) + s.total;
      perDay.set(day, d);

      for (const l of s.lines) {
        const cur = row(l.productId, l.name);
        cur.qty += l.qty;
        cur.revenue += l.total;
        for (const c of l.choices || []) row(c.productId, c.name).inMenu += l.qty;
      }
    }
    function row(id, name) {
      let r = perProduct.get(id);
      if (!r) perProduct.set(id, r = { productId: id, name, qty: 0, inMenu: 0, revenue: 0 });
      return r;
    }

    const productsSold = [...perProduct.values()].map(p => {
      const prod = prodById[p.productId];
      return { ...p, name: prod ? prod.name : p.name, total: p.qty + p.inMenu };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'fr'));

    const consumed = new Map();
    for (const p of perProduct.values()) {
      const prod = prodById[p.productId];
      if (!prod || !prod.recipe) continue;
      for (const r of prod.recipe) {
        consumed.set(r.ingredientId, (consumed.get(r.ingredientId) || 0) + r.qty * (p.qty + p.inMenu));
      }
    }

    // Réponses enregistrées avec les ventes valides (une correction ne compte donc pas deux fois)
    const survey = { yes: 0, no: 0, already: 0 };
    for (const s of valid) {
      if (s.survey === 'oui') survey.yes++;
      else if (s.survey === 'non') survey.no++;
      else if (s.survey === 'deja') survey.already++;
    }
    for (const a of answers || []) { // réponses de la version précédente (sondage après la vente)
      if (a.answer === 'oui') survey.yes++;
      else if (a.answer === 'non') survey.no++;
    }

    let hasCostData = false;
    let ingredientCost = 0;
    const ingredientRows = [...(ingredients || [])]
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      .map(ing => {
        const used = roundQty(consumed.get(ing.id) || 0);
        const init = stock[ing.id] != null ? stock[ing.id] : null;
        const unitCost = ingredientUnitCost(ing);
        if (unitCost != null) hasCostData = true;
        const cost = unitCost != null ? used * unitCost : null;
        if (cost != null) ingredientCost += cost;
        return {
          ingredientId: ing.id,
          name: ing.name,
          unit: ing.unit,
          consumed: used,
          initialStock: init,
          remaining: init != null ? roundQty(init - used) : null,
          unitCost,
          cost
        };
      });

    return {
      salesCount: valid.length,
      cancelledCount: (sales || []).length - valid.length,
      revenue,
      average: valid.length ? revenue / valid.length : null,
      payments,
      products: productsSold,
      days: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      ingredients: ingredientRows,
      hasCostData,
      ingredientCost: hasCostData ? ingredientCost : null,
      margin: hasCostData ? revenue - ingredientCost : null,
      survey
    };
  }

  // ---------- Export (structure des feuilles Excel) ----------

  /**
   * Prépare les feuilles du classeur Excel d'un événement.
   * Format de cellule : valeur simple, ou { v, s } avec s = bold|money|money4|date|time|datetime|pct.
   */
  function buildExportSheets({ event, sales, products, categories, ingredients, answers, now }) {
    const st = computeStats({ sales, products, ingredients, initialStock: event.initialStock, answers });
    const catById = indexById(categories);
    const ingById = indexById(ingredients);
    const prodById = indexById(products);
    const soldById = indexById(st.products.map(p => ({ ...p, id: p.productId })));
    const eur = c => (c == null ? null : { v: Math.round(c) / 100, s: 'money' });
    const eur4 = c => (c == null ? null : { v: Math.round(c * 100) / 10000, s: 'money4' });
    const B = v => ({ v, s: 'bold' });
    const H = arr => arr.map(B);
    const status = s => (isCancelled(s) ? 'ANNULÉE' : 'Valide');
    const sorted = [...sales].sort((a, b) => (a.number || 0) - (b.number || 0) || a.createdAt.localeCompare(b.createdAt));

    const bilan = [
      [B('Événement'), event.name],
      [B('Dates'), formatPeriod(event)],
      [B('Exporté le'), { v: now || new Date(), s: 'datetime' }],
      [],
      H(['Indicateur', 'Valeur']),
      ["Chiffre d'affaires (ventes valides)", eur(st.revenue)],
      ['Nombre de ventes valides', st.salesCount],
      ['Ventes annulées (exclues)', st.cancelledCount],
      ['Panier moyen', eur(st.average)],
      ['Encaissé en espèces', eur(st.payments.especes.amount)],
      ['Nombre de ventes en espèces', st.payments.especes.count],
      ['Encaissé par carte', eur(st.payments.carte.amount)],
      ['Nombre de ventes par carte', st.payments.carte.count]
    ];
    if (st.hasCostData) {
      bilan.push(['Coût théorique des ingrédients', eur(st.ingredientCost)]);
      bilan.push(['Marge brute estimée', eur(st.margin)]);
    }
    if (event.surveyQuestion || st.survey.yes || st.survey.no || st.survey.already) {
      const n = st.survey.yes + st.survey.no;
      bilan.push([], H(['Sondage', event.surveyQuestion || '']));
      bilan.push(['Réponses OUI', st.survey.yes, n ? { v: Math.round(st.survey.yes / n * 10000) / 10000, s: 'pct' } : null]);
      bilan.push(['Réponses NON', st.survey.no, n ? { v: Math.round(st.survey.no / n * 10000) / 10000, s: 'pct' } : null]);
      bilan.push(['Question déjà posée (client revenu)', st.survey.already]);
    }
    bilan.push([], H(['Jour', 'Ventes', "Chiffre d'affaires", 'Espèces', 'Carte']));
    for (const d of st.days) {
      bilan.push([{ v: dayToDate(d.day), s: 'date' }, d.count, eur(d.revenue), eur(d.especes || 0), eur(d.carte || 0)]);
    }
    bilan.push([], H(['Produit', 'Total servi', 'Vendu seul', 'Dans les menus', "Chiffre d'affaires"]));
    for (const p of st.products) bilan.push([p.name, p.total, p.qty, p.inMenu, eur(p.revenue)]);

    const ventes = [H(['N° vente', 'ID unique', 'Date', 'Heure', 'Événement', 'Montant', 'Mode de paiement', 'Statut', 'Nb articles', 'Annulée le', 'Raison annulation', 'Sondage'])];
    for (const s of sorted) {
      const d = new Date(s.createdAt);
      ventes.push([
        s.number, s.id, { v: d, s: 'date' }, { v: d, s: 'time' }, event.name, eur(s.total),
        PAYMENTS[s.payment] || s.payment, status(s),
        s.lines.reduce((n, l) => n + l.qty, 0),
        s.cancelledAt ? { v: new Date(s.cancelledAt), s: 'datetime' } : null,
        s.cancelReason || null,
        s.survey ? SURVEY[s.survey] : null
      ]);
    }

    const lignes = [H(['N° vente', 'ID unique', 'Date', 'Heure', 'Produit', 'Catégorie', 'Quantité', 'Prix unitaire', 'Total ligne', 'Statut vente', 'Détail du menu'])];
    for (const s of sorted) {
      const d = new Date(s.createdAt);
      for (const l of s.lines) {
        const prod = prodById[l.productId];
        const cat = prod && catById[prod.categoryId];
        lignes.push([s.number, s.id, { v: d, s: 'date' }, { v: d, s: 'time' }, l.name, cat ? cat.name : null, l.qty, eur(l.unitPrice), eur(l.total), status(s), choicesText(l) || null]);
      }
    }

    const produits = [H(['Produit', 'Catégorie', 'Prix de vente', 'Coût de revient', 'Marge brute', 'Marge %', 'Recette / composition', 'Remarque', 'Actif', 'Total servi', 'Vendu seul', 'Dans les menus', "Chiffre d'affaires"])];
    const sortedProducts = [...products].sort((a, b) => {
      const ca = catById[a.categoryId], cb = catById[b.categoryId];
      return (ca ? ca.order : 1e9) - (cb ? cb.order : 1e9) || (a.order || 0) - (b.order || 0);
    });
    for (const p of sortedProducts) {
      const m = productMargin(p, ingById);
      const sold = soldById[p.id];
      produits.push([
        p.name, catById[p.categoryId] ? catById[p.categoryId].name : null, eur(p.price),
        m ? eur4(m.cost) : null, m ? eur4(m.margin) : null, m && m.pct != null ? { v: Math.round(m.pct * 10000) / 10000, s: 'pct' } : null,
        [recipeText(p, ingById), menuText(p, prodById)].filter(Boolean).join(' | ') || null,
        m && !m.complete ? "Prix d'achat manquant : " + m.missing.join(', ') : null,
        p.active !== false ? 'Oui' : 'Non',
        sold ? sold.total : 0, sold ? sold.qty : 0, sold ? sold.inMenu : 0, eur(sold ? sold.revenue : 0)
      ]);
    }

    const ingr = [H(['Ingrédient', 'Unité', 'Stock initial', 'Consommation théorique', 'Stock théorique', "Prix d'achat", 'Quantité achetée', 'Coût unitaire', 'Coût de la consommation'])];
    for (const r of st.ingredients) {
      const ing = ingById[r.ingredientId];
      ingr.push([
        r.name, r.unit, r.initialStock, r.consumed, r.remaining,
        eur(ing.purchasePrice), ing.purchaseQty || null, eur4(r.unitCost), eur4(r.cost)
      ]);
    }

    return [
      { name: 'Bilan', rows: bilan, widths: [36, 22, 18, 16, 18] },
      { name: 'Ventes', rows: ventes, widths: [10, 38, 12, 8, 28, 12, 16, 10, 11, 17, 30], freeze: true },
      { name: 'Lignes de vente', rows: lignes, widths: [10, 38, 12, 8, 22, 18, 10, 13, 12, 12, 50], freeze: true },
      { name: 'Produits', rows: produits, widths: [24, 18, 13, 15, 13, 10, 60, 30, 7, 12, 12, 15, 17], freeze: true },
      { name: 'Ingrédients', rows: ingr, widths: [24, 12, 13, 22, 15, 13, 17, 13, 22], freeze: true }
    ];
  }

  return {
    PAYMENTS, SURVEY, CANCELLED, VALID,
    uuid, indexById, roundQty,
    parseDecimal, parseEuros, formatEuros, formatEurosPrecise, formatQty, formatPct,
    localDay, dayToDate, formatDate, formatTime, formatDayLabel, formatPeriod, fileStamp, slug,
    isMenu, lineKey, cartAdd, cartChange, cartTotal, lineToCart, choicesText,
    buildSale, cancelSale, isCancelled,
    ingredientUnitCost, productCost, productMargin, recipeText, menuText,
    computeStats, buildExportSheets
  };
});
