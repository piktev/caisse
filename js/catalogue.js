/*
 * Catalogue pré-rempli de la buvette du Challenge Lamouret (Degré+ Saint-Fargeau-Ponthierry).
 * Chargé automatiquement au premier lancement (base vide), ou à la demande depuis
 * Admin → Produits. Tout reste modifiable ensuite dans l'administration.
 *
 * Le chargement n'écrase rien : un produit, une catégorie ou un ingrédient qui
 * existe déjà (même nom) est conservé tel quel.
 */
(function (root, factory) {
  const C = factory(typeof module === 'object' && module.exports ? require('./logic.js') : root.Logic);
  if (typeof module === 'object' && module.exports) module.exports = C;
  else root.Catalogue = C;
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  const EVENT = {
    name: 'Challenge Lamouret 2026',
    startDate: '2026-10-10',
    endDate: '2026-10-11',
    description: 'Buvette Degré+ Saint-Fargeau-Ponthierry',
    surveyQuestion: 'Seriez-vous intéressé(e) par un t-shirt du Challenge Lamouret (environ 15-20 €) ?'
  };

  // [nom, unité]
  const INGREDIENTS = [
    ['Baguette', 'unité'],
    ['Jambon', 'tranche'],
    ['Jambon de poulet', 'tranche'],
    ['Emmental', 'tranche'],
    ['Salade', 'feuille'],
    ['Mayonnaise', 'portion'],
    ['Chips', 'sachet']
  ];

  // 1 baguette = 2 sandwichs ; jambon et poulet : 2 tranches, 2 emmental, 3 feuilles de salade, mayo.
  // Végé : 4 tranches d'emmental, 6 feuilles de salade, mayo.
  const sandwich = viande => [['Baguette', 0.5], [viande, 2], ['Emmental', 2], ['Salade', 3], ['Mayonnaise', 1]];
  const SANDWICHS = ['Sandwich jambon', 'Sandwich poulet', 'Sandwich végé'];
  const BOISSONS = ['Café', 'Thé', 'Eau 50 cl', 'Coca-Cola', 'Coca-Cola Zéro', 'Orangina', 'Oasis', 'Fuze Tea'];
  const CREPES = ['Crêpe sucre', 'Crêpe Nutella', 'Crêpe confiture'];

  // [catégorie, [{ name, price (centimes), recipe?, menu? }]] — dans l'ordre de l'écran de caisse
  const CATEGORIES = [
    ['Sandwichs & menu', [
      { name: 'Menu', price: 650, recipe: [['Chips', 1]], menu: [['Sandwich', SANDWICHS], ['Boisson', BOISSONS], ['Crêpe', CREPES]] },
      { name: 'Sandwich jambon', price: 400, recipe: sandwich('Jambon') },
      { name: 'Sandwich poulet', price: 400, recipe: sandwich('Jambon de poulet') },
      { name: 'Sandwich végé', price: 400, recipe: [['Baguette', 0.5], ['Emmental', 4], ['Salade', 6], ['Mayonnaise', 1]] }
    ]],
    ['Boissons', [
      { name: 'Café', price: 100 }, { name: 'Thé', price: 100 }, { name: 'Eau 50 cl', price: 100 },
      { name: 'Coca-Cola', price: 150 }, { name: 'Coca-Cola Zéro', price: 150 }, { name: 'Orangina', price: 150 },
      { name: 'Oasis', price: 150 }, { name: 'Fuze Tea', price: 150 }
    ]],
    ['Crêpes', [
      { name: 'Crêpe sucre', price: 100 }, { name: 'Crêpe Nutella', price: 150 }, { name: 'Crêpe confiture', price: 150 }
    ]],
    ['Viennoiseries', [{ name: 'Croissant', price: 200 }, { name: 'Pain au chocolat', price: 200 }]],
    ['Fruits', [{ name: 'Pomme', price: 100 }, { name: 'Banane', price: 100 }]],
    ['Consigne', [{ name: 'Consigne verre', price: 100 }]],
    ['Boutique', [
      { name: 'Magnésie 150 ml', price: 900 }, { name: 'Magnésie 250 ml', price: 1200 }, { name: 'T-shirt Degré+', price: 1900 }
    ]]
  ];

  const norm = s => String(s || '').trim().toLowerCase();

  /**
   * Calcule ce qu'il faut AJOUTER à la base pour avoir le catalogue complet.
   * existing = { events, categories, products, ingredients } (contenu actuel)
   * → { events, categories, products, ingredients } à enregistrer (nouveaux éléments seulement)
   */
  function build(existing, now) {
    const out = { events: [], categories: [], products: [], ingredients: [] };

    const ingByName = new Map((existing.ingredients || []).map(i => [norm(i.name), i]));
    for (const [name, unit] of INGREDIENTS) {
      if (ingByName.has(norm(name))) continue;
      const ing = { id: L.uuid(), name, unit, purchasePrice: null, purchaseQty: null };
      ingByName.set(norm(name), ing);
      out.ingredients.push(ing);
    }

    const catByName = new Map((existing.categories || []).map(c => [norm(c.name), c]));
    let catOrder = (existing.categories || []).reduce((m, c) => Math.max(m, c.order), -1) + 1;
    const prodByName = new Map((existing.products || []).map(p => [norm(p.name), p]));
    let prodOrder = (now || new Date()).getTime();
    const menus = [];

    for (const [catName, items] of CATEGORIES) {
      let cat = catByName.get(norm(catName));
      if (!cat) {
        cat = { id: L.uuid(), name: catName, order: catOrder++ };
        catByName.set(norm(catName), cat);
        out.categories.push(cat);
      }
      for (const item of items) {
        if (prodByName.has(norm(item.name))) continue;
        const p = {
          id: L.uuid(), name: item.name, price: item.price, categoryId: cat.id, active: true, order: prodOrder++,
          recipe: (item.recipe || []).map(([ing, qty]) => ({ ingredientId: ingByName.get(norm(ing)).id, qty }))
        };
        if (item.menu) menus.push([p, item.menu]);
        prodByName.set(norm(item.name), p);
        out.products.push(p);
      }
    }
    // Les choix des menus sont reliés une fois tous les produits connus.
    for (const [p, steps] of menus) {
      p.menu = steps.map(([label, names]) => ({
        label,
        options: names.map(n => prodByName.get(norm(n))).filter(Boolean).map(x => x.id)
      }));
    }

    if (!(existing.events || []).some(e => norm(e.name) === norm(EVENT.name))) {
      out.events.push({ id: L.uuid(), ...EVENT, initialStock: {}, archived: false, createdAt: (now || new Date()).toISOString() });
    }
    return out;
  }

  return { EVENT, INGREDIENTS, CATEGORIES, build };
});
