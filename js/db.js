/*
 * Stockage local persistant (IndexedDB). Rien n'est envoyé sur Internet.
 *
 * Magasins (tables) :
 *   events       { id, name, startDate, endDate, description, archived, initialStock: {ingredientId: qté}, createdAt }
 *   categories   { id, name, order }
 *   products     { id, name, price (centimes), categoryId, active, order, recipe: [{ ingredientId, qty }] }
 *   ingredients  { id, name, unit, purchasePrice (centimes|null), purchaseQty (nombre|null) }
 *   sales        { id, eventId, number, createdAt, total, payment, status, lines: [...], deviceId, cancelledAt, cancelReason }
 *   settings     { key, value }   (currentEventId, pin, deviceId, lastBackupAt)
 *
 * Une vente et ses lignes sont écrites dans UNE SEULE transaction : soit tout est
 * enregistré, soit rien. La promesse n'est résolue qu'une fois la transaction
 * terminée sur disque (durability: 'strict').
 */
(function (root) {
  'use strict';

  const NAME = 'caisse-buvette';
  const VERSION = 1;
  const STORES = ['events', 'categories', 'products', 'ingredients', 'sales', 'settings'];
  const APP_ID = 'caisse-buvette';
  const BACKUP_FORMAT = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error("Ce navigateur ne permet pas le stockage local (IndexedDB)."));
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ['events', 'categories', 'products', 'ingredients']) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('sales')) {
          db.createObjectStore('sales', { keyPath: 'id' }).createIndex('eventId', 'eventId');
        }
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Base de données bloquée : fermez les autres onglets de l'application."));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  /**
   * Exécute `work(tx, done)` dans une transaction. La promesse est résolue avec la
   * valeur passée à done() seulement quand la transaction est validée.
   */
  async function run(stores, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = mode === 'readwrite'
        ? db.transaction(stores, mode, { durability: 'strict' })
        : db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Enregistrement annulé.'));
      try {
        work(tx, v => { result = v; });
      } catch (e) {
        try { tx.abort(); } catch (_) { /* déjà terminée */ }
        reject(e);
      }
    });
  }

  const getAll = store => run([store], 'readonly', (tx, done) => {
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => done(r.result);
  });

  const get = (store, id) => run([store], 'readonly', (tx, done) => {
    const r = tx.objectStore(store).get(id);
    r.onsuccess = () => done(r.result || null);
  });

  const put = (store, obj) => run([store], 'readwrite', (tx, done) => {
    tx.objectStore(store).put(obj);
    done(obj);
  });

  const putMany = (store, objs) => run([store], 'readwrite', tx => {
    const s = tx.objectStore(store);
    for (const o of objs) s.put(o);
  });

  const del = (store, id) => run([store], 'readwrite', tx => { tx.objectStore(store).delete(id); });

  const salesByEvent = eventId => run(['sales'], 'readonly', (tx, done) => {
    const r = tx.objectStore('sales').index('eventId').getAll(eventId);
    r.onsuccess = () => done(r.result);
  });

  const countSalesByEvent = eventId => run(['sales'], 'readonly', (tx, done) => {
    const r = tx.objectStore('sales').index('eventId').count(eventId);
    r.onsuccess = () => done(r.result);
  });

  /**
   * Enregistre une vente. Le numéro (#n) est attribué dans la même transaction.
   * `add` (et non `put`) : si une vente avec le même id existe déjà (double
   * validation du même panier), l'écriture échoue avec ConstraintError au lieu
   * de créer un doublon.
   */
  const addSale = sale => run(['sales'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('sales');
    const c = store.index('eventId').count(sale.eventId);
    c.onsuccess = () => {
      const rec = { ...sale, number: c.result + 1 };
      store.add(rec);
      done(rec);
    };
  });

  /** Vrai si au moins une vente (même annulée) contient ce produit. */
  const isProductSold = productId => run(['sales'], 'readonly', (tx, done) => {
    done(false);
    const r = tx.objectStore('sales').openCursor();
    r.onsuccess = () => {
      const cur = r.result;
      if (!cur) return;
      if (cur.value.lines.some(l => l.productId === productId)) return done(true);
      cur.continue();
    };
  });

  /** Supprime un événement ET toutes ses ventes (une seule transaction). */
  const deleteEvent = eventId => run(['events', 'sales'], 'readwrite', tx => {
    tx.objectStore('events').delete(eventId);
    const r = tx.objectStore('sales').index('eventId').openKeyCursor(IDBKeyRange.only(eventId));
    r.onsuccess = () => {
      const cur = r.result;
      if (!cur) return;
      tx.objectStore('sales').delete(cur.primaryKey);
      cur.continue();
    };
  });

  async function getSettings() {
    const rows = await getAll('settings');
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  const setSetting = (key, value) => put('settings', { key, value });

  // ---------- Sauvegarde / restauration ----------

  const exportAll = () => run(STORES, 'readonly', (tx, done) => {
    const data = {};
    for (const s of STORES) {
      const r = tx.objectStore(s).getAll();
      r.onsuccess = () => {
        data[s] = s === 'settings' ? r.result.filter(x => x.key !== 'deviceId') : r.result;
      };
    }
    done({ app: APP_ID, format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), data });
  });

  /** Vérifie un fichier de sauvegarde et renvoie un résumé, ou lève une erreur. */
  function checkBackup(b) {
    if (!b || b.app !== APP_ID || !b.data) throw new Error("Ce fichier n'est pas une sauvegarde de la caisse.");
    if (b.format > BACKUP_FORMAT) throw new Error('Sauvegarde créée par une version plus récente de l\'application.');
    for (const s of STORES) {
      if (b.data[s] != null && !Array.isArray(b.data[s])) throw new Error(`Sauvegarde invalide (${s}).`);
    }
    for (const sale of b.data.sales || []) {
      if (!sale.id || !sale.eventId || !Array.isArray(sale.lines)) throw new Error('Sauvegarde invalide (vente incomplète).');
    }
    for (const s of ['events', 'categories', 'products', 'ingredients']) {
      for (const x of b.data[s] || []) if (!x.id) throw new Error(`Sauvegarde invalide (${s} sans identifiant).`);
    }
    return {
      exportedAt: b.exportedAt,
      events: (b.data.events || []).length,
      products: (b.data.products || []).length,
      sales: (b.data.sales || []).length
    };
  }

  /** Remplace TOUTES les données par celles de la sauvegarde (transaction unique). */
  async function importAll(b) {
    checkBackup(b);
    const deviceId = (await get('settings', 'deviceId')) || null;
    return run(STORES, 'readwrite', tx => {
      for (const s of STORES) {
        const store = tx.objectStore(s);
        store.clear();
        for (const x of b.data[s] || []) {
          if (s === 'settings' && x.key === 'deviceId') continue;
          store.put(x);
        }
      }
      if (deviceId) tx.objectStore('settings').put(deviceId);
    });
  }

  /** Efface toutes les données (sauf l'identifiant de l'appareil). */
  async function clearAll() {
    const deviceId = (await get('settings', 'deviceId')) || null;
    return run(STORES, 'readwrite', tx => {
      for (const s of STORES) tx.objectStore(s).clear();
      if (deviceId) tx.objectStore('settings').put(deviceId);
    });
  }

  root.DB = {
    open, getAll, get, put, putMany, del, salesByEvent, countSalesByEvent, addSale,
    isProductSold, deleteEvent, getSettings, setSetting, exportAll, checkBackup, importAll, clearAll
  };
})(self);
