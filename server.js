// Angelus Vit – Backend-Prototyp
// Verbindet: Barcode-Auflösung (Open Food Facts) + Rückrufdaten (lebensmittelwarnung.de)
//
// WICHTIG: Prototyp zum Testen der Machbarkeit. Vor produktivem Einsatz:
// - Lizenzfrage der Rückruf-Datenquelle klären (siehe README.md)
// - Matching-Genauigkeit mit echten historischen Rückrufen validieren
// - Fehlerbehandlung, Monitoring und Rate-Limits ergänzen

import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json());

// Liefert die Frontend-Datei (public/index.html) direkt mit aus –
// dadurch kann auch das iPhone im selben WLAN die App per Adresse öffnen,
// ohne die HTML-Datei manuell übertragen zu müssen.
app.use(express.static(path.join(__dirname, 'public')));

// CORS: für den Prototyp offen, damit die HTML-Datei (file:// oder anderer Origin)
// die API ansprechen kann. Vor Produktivbetrieb auf die echte Frontend-Domain einschränken.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3001;
const RECALL_REFRESH_MS = 20 * 60 * 1000; // alle 20 Minuten neu laden
const SIMILARITY_THRESHOLD = 0.45; // Prototyp-Schwellenwert – mit echten Daten kalibrieren

let recallCache = [];
let lastRefresh = null;

// ---------------------------------------------------------------------------
// Speicher (bewusst einfach: nur im Arbeitsspeicher).
// ACHTUNG: Bei jedem Neustart/Deploy des Servers sind diese Daten weg.
// Für echte Nutzer später durch eine richtige Datenbank ersetzen.
// ---------------------------------------------------------------------------
const purchases = [];      // { id, deviceId, barcode, name, charge, status, date, notified[] }
const subscriptions = {};  // deviceId -> Push-Abo des Browsers
const testRecalls = [];    // manuell zu Testzwecken erzeugte "Rückrufe"
let purchaseId = 1;

// VAPID-Schlüssel: weisen den Server gegenüber Apple/Google als Absender aus.
// Werden beim Start erzeugt, sofern nicht als Umgebungsvariablen gesetzt.
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  };
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  console.log('[push] Neue VAPID-Schlüssel erzeugt (bei Neustart ändern sie sich).');
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:kontakt@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);
let lastRefreshError = null;

// ---------------------------------------------------------------------------
// 1) Rückrufe von lebensmittelwarnung.de laden
//    (über die offizielle CLI, die die amtlichen RSS-Feeds parst)
// ---------------------------------------------------------------------------
async function refreshRecalls() {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      [
        '--yes',
        '--package=@maschinenlesbar.org/lebensmittelwarnung-cli',
        'lebensmittel',
        'warnings',
        '--type', 'lebensmittel',
        '--compact'
      ],
      { maxBuffer: 1024 * 1024 * 20 }
    );
    const vorher = new Set(recallCache.map(r => r.id || r.title));
    recallCache = JSON.parse(stdout);
    lastRefresh = new Date().toISOString();
    lastRefreshError = null;
    console.log(`[recalls] ${recallCache.length} aktuelle Meldungen geladen (${lastRefresh})`);

    // Nur wirklich NEUE Meldungen gegen gespeicherte Einkäufe prüfen
    if (vorher.size > 0) {
      const neue = recallCache.filter(r => !vorher.has(r.id || r.title));
      if (neue.length) {
        const versendet = await matchPurchasesAgainstRecalls(neue);
        console.log(`[push] ${neue.length} neue Meldungen, ${versendet} Benachrichtigungen versendet`);
      }
    }
  } catch (err) {
    lastRefreshError = err.message;
    console.error('[recalls] Aktualisierung fehlgeschlagen:', err.message);
  }
}

// ---------------------------------------------------------------------------
// 2) Einfache Textähnlichkeit (Dice-Koeffizient über Bigramme)
//    – bewusst simpel gehalten, kein externes Paket nötig.
//    Für den echten Betrieb: durch eine geprüfte Fuzzy-Matching-Bibliothek
//    ersetzen und mit echten Rückruf-/Produktnamen-Paaren testen.
// ---------------------------------------------------------------------------
function bigrams(str) {
  const s = str.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, '').trim();
  const result = [];
  for (let i = 0; i < s.length - 1; i++) result.push(s.slice(i, i + 2));
  return result;
}

function similarity(a, b) {
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  if (!bgA.length || !bgB.length) return 0;
  const pool = [...bgB];
  let matches = 0;
  for (const bg of bgA) {
    const idx = pool.indexOf(bg);
    if (idx !== -1) {
      matches++;
      pool.splice(idx, 1);
    }
  }
  return (2 * matches) / (bgA.length + bgB.length);
}

// ---------------------------------------------------------------------------
// 3) Barcode -> Produktname (Open Food Facts – offiziell, kostenlos, kein Key)
// ---------------------------------------------------------------------------
async function lookupBarcode(barcode) {
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`, {
    headers: { 'User-Agent': 'AngelusVitPrototype/0.1 (kontakt@example.com)' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return {
    name: data.product.product_name_de || data.product.product_name || 'Unbekanntes Produkt',
    brand: data.product.brands || null
  };
}

// ---------------------------------------------------------------------------
// Endpunkte
// ---------------------------------------------------------------------------

app.get('/api/status', (req, res) => {
  res.json({
    letzteAktualisierung: lastRefresh,
    letzterFehler: lastRefreshError,
    anzahlRueckrufe: recallCache.length
  });
});

app.get('/api/recalls', (req, res) => {
  const alle = [...testRecalls, ...recallCache];
  res.json({ updated: lastRefresh, count: alle.length, recalls: alle });
});

// Diagnose: zeigt die Rohdaten der ersten Meldungen inkl. aller Feldnamen.
// Hilft zu prüfen, in welchem Feld die Chargennummer tatsächlich steht.
app.get('/api/debug', (req, res) => {
  res.json({
    anzahl: recallCache.length,
    feldnamen: recallCache.length ? Object.keys(recallCache[0]) : [],
    beispiele: recallCache.slice(0, 3)
  });
});

app.get('/api/lookup', async (req, res) => {
  const barcode = (req.query.barcode || '').trim();
  if (!barcode) return res.status(400).json({ error: 'Parameter "barcode" fehlt' });
  try {
    const product = await lookupBarcode(barcode);
    if (!product) return res.status(404).json({ error: 'Produkt nicht in Open Food Facts gefunden' });
    res.json(product);
  } catch (err) {
    res.status(502).json({ error: 'Open Food Facts nicht erreichbar', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sucht eine Chargennummer in ALLEN Textfeldern einer Rückrufmeldung.
// Grund: je nach Datenquelle steht die Charge mal in einem eigenen Feld,
// mal nur im Fließtext der Meldung.
// ---------------------------------------------------------------------------
function recallContainsCharge(recall, charge) {
  const needle = charge.toLowerCase().trim();
  if (needle.length < 3) return false; // zu kurz → zu viele Zufallstreffer
  const haystack = JSON.stringify(recall).toLowerCase();
  return haystack.includes(needle);
}

// ---------------------------------------------------------------------------
// Namensabgleich mit Wortgewichtung.
// Reine Zeichenketten-Ähnlichkeit scheitert an Produktnamen wie
// "Kölln Zauberfleks Schoko (375g)" vs. "Kölln Müsli Schoko". Deshalb wird
// hier über Wörter verglichen: lange Wörter (Marke, Produktlinie) zählen mehr
// als kurze, Mengenangaben und Füllwörter fallen raus.
// ---------------------------------------------------------------------------
const NOISE_WORDS = new Set([
  'g', 'kg', 'mg', 'ml', 'cl', 'l', 'stk', 'stueck', 'stück', 'packung', 'pack',
  'beutel', 'dose', 'glas', 'flasche', 'becher', 'tafel', 'der', 'die', 'das',
  'und', 'mit', 'im', 'in', 'von', 'vom', 'fuer', 'für', 'pro', 'ca', 'je'
]);

function normalizeTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[®™©]/g, ' ')
    .replace(/[^a-zäöüß0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length >= 2 && !NOISE_WORDS.has(t) && !/^\d+$/.test(t));
}

function nameScore(name, recallTitle) {
  const a = normalizeTokens(name);
  const b = normalizeTokens(recallTitle);
  if (!a.length || !b.length) return 0;

  let gewichtGesamt = 0;
  let gewichtTreffer = 0;

  for (const token of a) {
    const gewicht = token.length >= 5 ? 2 : 1; // längere Wörter sind aussagekräftiger
    gewichtGesamt += gewicht;

    if (b.includes(token)) {
      gewichtTreffer += gewicht;
      continue;
    }
    // Teiltreffer: "Zauberfleks" vs. "Zauberflek", "Schokolade" vs. "Schoko"
    const stamm = token.slice(0, 5);
    if (b.some(other => other.startsWith(stamm) || token.startsWith(other.slice(0, 5)))) {
      gewichtTreffer += gewicht * 0.6;
    }
  }

  const wortScore = gewichtGesamt ? gewichtTreffer / gewichtGesamt : 0;
  const zeichenScore = similarity(name, recallTitle) * 0.9; // Rückfallebene
  return Math.max(wortScore, zeichenScore);
}

// Liefert die nach Namen passenden Rückrufe, beste zuerst.
function findeKandidaten(name, rueckrufe) {
  if (!name) return [];
  return rueckrufe
    .map(r => ({ recall: r, score: nameScore(name, r.title) }))
    .filter(c => c.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Zweistufige Prüfung:
//   Stufe 1 – der Name grenzt ein, welche Meldungen überhaupt in Frage kommen.
//   Stufe 2 – die Chargennummer entscheidet innerhalb dieser Auswahl.
//
// Die frühere Variante hat bei manueller Chargeneingabe blind alle Meldungen
// durchsucht. Da Chargennummern nicht herstellerübergreifend eindeutig sind,
// entstanden dabei Fehlalarme. Ein reiner Chargentreffer ohne Namen gilt jetzt
// als Hinweis, der bestätigt werden muss, nicht als Warnung.
// ---------------------------------------------------------------------------
app.post('/api/check', async (req, res) => {
  const barcode = req.body?.barcode ? String(req.body.barcode).trim() : '';
  const charge = req.body?.charge ? String(req.body.charge).trim() : '';
  const bezeichnung = req.body?.bezeichnung ? String(req.body.bezeichnung).trim() : '';

  if (!barcode && !charge && !bezeichnung) {
    return res.status(400).json({ error: 'Bitte Barcode, Bezeichnung oder Chargennummer angeben' });
  }

  const product = barcode ? await lookupBarcode(barcode).catch(() => null) : null;

  // Die manuelle Eingabe hat Vorrang: Wer die Packung in der Hand hält, weiß
  // mehr als die Datenbank.
  const name = bezeichnung || product?.name || null;
  const nameQuelle = bezeichnung ? 'manuell' : (product?.name ? 'datenbank' : null);

  const alleRueckrufe = [...testRecalls, ...recallCache];
  const kandidaten = findeKandidaten(name, alleRueckrufe);

  const kandidatenAusgabe = kandidaten.slice(0, 5).map(c => ({
    id: c.recall.id || c.recall.title,
    titel: c.recall.title,
    grund: c.recall.reason,
    chargen: c.recall.lotNumbers || '',
    gemeldet: c.recall.published || null,
    score: Math.round(c.score * 100) / 100
  }));

  // ---- Fall A: Name vorhanden ------------------------------------------
  if (name) {
    if (kandidaten.length && charge) {
      const bestaetigt = kandidaten.find(c => recallContainsCharge(c.recall, charge));
      if (bestaetigt) {
        return res.json({
          status: 'treffer_bestaetigt',
          barcode: barcode || null, charge, name, nameQuelle,
          produkt: product, treffer: bestaetigt.recall,
          kandidaten: kandidatenAusgabe
        });
      }
      return res.json({
        status: 'charge_weicht_ab',
        barcode: barcode || null, charge, name, nameQuelle,
        produkt: product, treffer: null,
        kandidaten: kandidatenAusgabe
      });
    }

    if (kandidaten.length) {
      // Name passt, Charge fehlt noch – nachfragen statt warnen.
      return res.json({
        status: 'rueckfrage',
        barcode: barcode || null, charge: null, name, nameQuelle,
        produkt: product, treffer: null,
        kandidaten: kandidatenAusgabe
      });
    }

    return res.json({
      status: 'kein_rueckruf',
      barcode: barcode || null, charge: charge || null, name, nameQuelle,
      produkt: product, treffer: null, kandidaten: []
    });
  }

  // ---- Fall B: kein Name, aber eine Chargennummer -----------------------
  if (charge) {
    const chargenFunde = alleRueckrufe
      .filter(r => recallContainsCharge(r, charge))
      .slice(0, 5)
      .map(r => ({
        id: r.id || r.title,
        titel: r.title,
        grund: r.reason,
        chargen: r.lotNumbers || '',
        gemeldet: r.published || null,
        score: null
      }));

    return res.json({
      status: chargenFunde.length ? 'nur_charge_hinweis' : 'kein_rueckruf',
      barcode: barcode || null, charge, name: null, nameQuelle: null,
      produkt: null, treffer: null, kandidaten: chargenFunde
    });
  }

  // ---- Fall C: Barcode unbekannt, nichts zum Vergleichen ----------------
  return res.json({
    status: 'name_noetig',
    barcode: barcode || null, charge: null, name: null, nameQuelle: null,
    produkt: null, treffer: null, kandidaten: []
  });
});

// ---------------------------------------------------------------------------
// Push-Benachrichtigungen
// ---------------------------------------------------------------------------

// Öffentlichen Schlüssel abholen (braucht der Browser zum Abonnieren)
app.get('/api/push/key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Browser meldet sein Push-Abo an
app.post('/api/push/subscribe', (req, res) => {
  const { deviceId, subscription } = req.body || {};
  if (!deviceId || !subscription) {
    return res.status(400).json({ error: 'deviceId und subscription erforderlich' });
  }
  subscriptions[deviceId] = subscription;
  console.log(`[push] Abo gespeichert für Gerät ${deviceId}`);
  res.json({ ok: true });
});

// Testnachricht direkt schicken
app.post('/api/push/test', async (req, res) => {
  const { deviceId } = req.body || {};
  const sub = subscriptions[deviceId];
  if (!sub) return res.status(404).json({ error: 'Kein Push-Abo für dieses Gerät' });
  try {
    await sendPush(deviceId, {
      title: 'Angelus Vit',
      body: 'Testbenachrichtigung – Push funktioniert.'
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendPush(deviceId, payload) {
  const sub = subscriptions[deviceId];
  if (!sub) return false;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error(`[push] Versand an ${deviceId} fehlgeschlagen:`, err.statusCode || err.message);
    // Abgelaufene Abos entfernen
    if (err.statusCode === 404 || err.statusCode === 410) delete subscriptions[deviceId];
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gespeicherte Einkäufe
// ---------------------------------------------------------------------------

app.get('/api/purchases', (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ error: 'deviceId fehlt' });
  res.json({ purchases: purchases.filter(p => p.deviceId === deviceId) });
});

app.post('/api/purchases', (req, res) => {
  const { deviceId, barcode, name, charge, status } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId fehlt' });

  const entry = {
    id: purchaseId++,
    deviceId,
    barcode: barcode || '',
    name: name || 'Unbekanntes Produkt',
    charge: charge || '',
    status: status || 'unklar',
    date: new Date().toISOString(),
    notified: []
  };
  purchases.push(entry);
  res.json({ ok: true, purchase: entry });
});

app.post('/api/purchases/consumed', (req, res) => {
  const { deviceId, purchaseId: pid, verzehrt } = req.body || {};
  const purchase = purchases.find(p => p.id === pid && p.deviceId === deviceId);
  if (!purchase) return res.status(404).json({ error: 'Einkauf nicht gefunden' });

  purchase.verzehrt = !!verzehrt;
  purchase.verzehrtBeantwortetAm = new Date().toISOString();
  console.log(`[antwort] Gerät ${deviceId}: "${purchase.name}" verzehrt = ${purchase.verzehrt}`);

  res.json({ ok: true, purchase });
});

app.post('/api/purchases/delete', (req, res) => {
  const { deviceId, id } = req.body || {};
  const idx = purchases.findIndex(p => p.id === id && p.deviceId === deviceId);
  if (idx >= 0) purchases.splice(idx, 1);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// TEST-FUNKTION (nur für den Prototyp!)
// Erklärt ein bereits gespeichertes Produkt zum Rückruf und löst damit
// den kompletten Benachrichtigungs-Ablauf aus.
// ---------------------------------------------------------------------------
app.post('/api/test/recall', async (req, res) => {
  const { deviceId, purchaseId: pid, grund, verzoegerungSekunden } = req.body || {};
  const purchase = purchases.find(p => p.id === pid && p.deviceId === deviceId);
  if (!purchase) return res.status(404).json({ error: 'Einkauf nicht gefunden' });

  const fakeRecall = {
    id: 'TEST-' + Date.now(),
    title: purchase.name,
    reason: grund || 'TESTFALL – Kontamination (simuliert, kein echter Rückruf)',
    lotNumbers: purchase.charge || '',
    barcode: purchase.barcode || '',
    published: new Date().toISOString(),
    istTestfall: true
  };

  const delaySek = Number(verzoegerungSekunden) || 0;

  if (delaySek > 0) {
    // Verzögert auslösen, damit die Benachrichtigung ankommt, während
    // die App bereits geschlossen ist.
    setTimeout(async () => {
      testRecalls.unshift(fakeRecall);
      const versendet = await matchPurchasesAgainstRecalls([fakeRecall]);
      console.log(`[test] Verzögerter Testrückruf ausgelöst, ${versendet} Benachrichtigung(en) versendet`);
    }, delaySek * 1000);

    return res.json({ ok: true, recall: fakeRecall, verzoegertUm: delaySek });
  }

  testRecalls.unshift(fakeRecall);
  const versendet = await matchPurchasesAgainstRecalls([fakeRecall]);
  res.json({ ok: true, recall: fakeRecall, benachrichtigungenVersendet: versendet });
});

// ---------------------------------------------------------------------------
// Abgleich: neue Rückrufe gegen gespeicherte Einkäufe → Push verschicken
// ---------------------------------------------------------------------------
// Bewertet einen gespeicherten Einkauf gegen eine Rückrufmeldung.
// Ergebnis: 'bestaetigt', 'verdacht' oder null.
function bewerteTreffer(purchase, recall) {
  // Gleicher Barcode in der Meldung: eindeutig, da maschinell gelesen.
  if (purchase.barcode && recall.barcode && purchase.barcode === recall.barcode) {
    return 'bestaetigt';
  }

  const nameTrifft =
    purchase.name && recall.title &&
    nameScore(purchase.name, recall.title) >= SIMILARITY_THRESHOLD;
  const chargeTrifft =
    purchase.charge && purchase.charge !== '–' &&
    recallContainsCharge(recall, purchase.charge);

  // Beide Stufen erfüllt: richtiges Produkt, richtige Charge.
  if (nameTrifft && chargeTrifft) return 'bestaetigt';

  // Nur eine Stufe: reicht für eine Warnung nicht aus, aber für eine Rückfrage.
  // Der Name allein sagt nichts über die Charge, die Charge allein ist nicht
  // herstellerübergreifend eindeutig.
  if (nameTrifft || chargeTrifft) return 'verdacht';

  return null;
}

async function matchPurchasesAgainstRecalls(newRecalls) {
  let count = 0;

  for (const purchase of purchases) {
    for (const recall of newRecalls) {
      const recallId = recall.id || recall.title;
      if (purchase.notified.includes(recallId)) continue; // schon gemeldet

      const stufe = bewerteTreffer(purchase, recall);
      if (!stufe) continue;

      purchase.status = stufe === 'bestaetigt' ? 'warn' : 'verdacht';
      purchase.notified.push(recallId);

      const testVorsatz = recall.istTestfall ? 'TEST: ' : '';
      const produktText = `${purchase.name}${purchase.charge && purchase.charge !== '–' ? ' (Charge ' + purchase.charge + ')' : ''}`;

      const ok = await sendPush(purchase.deviceId, {
        title: stufe === 'bestaetigt'
          ? `${testVorsatz}Rückruf für dein Produkt`
          : `${testVorsatz}Möglicher Rückruf – bitte prüfen`,
        body: stufe === 'bestaetigt'
          ? `${produktText}: ${recall.reason || 'Rückruf gemeldet'}`
          : `Eine Meldung könnte auf ${produktText} zutreffen. Bitte Chargennummer auf der Verpackung vergleichen.`,
        url: `/?warnung=${purchase.id}&produkt=${encodeURIComponent(purchase.name)}&stufe=${stufe}`
      });
      if (ok) count++;
    }
  }
  return count;
}

app.listen(PORT, async () => {
  console.log(`Angelus-Vit-Backend läuft auf http://localhost:${PORT}`);
  await refreshRecalls();
  setInterval(refreshRecalls, RECALL_REFRESH_MS);
});
