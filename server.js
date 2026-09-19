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
    recallCache = JSON.parse(stdout);
    lastRefresh = new Date().toISOString();
    lastRefreshError = null;
    console.log(`[recalls] ${recallCache.length} aktuelle Meldungen geladen (${lastRefresh})`);
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
  res.json({ updated: lastRefresh, count: recallCache.length, recalls: recallCache });
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

app.post('/api/check', async (req, res) => {
  const barcode = req.body?.barcode ? String(req.body.barcode).trim() : '';
  const charge = req.body?.charge ? String(req.body.charge).trim() : '';

  if (!barcode && !charge) {
    return res.status(400).json({ error: 'Bitte Barcode oder Chargennummer angeben' });
  }

  const product = barcode ? await lookupBarcode(barcode).catch(() => null) : null;
  const productName = product?.name || null;

  const candidates = productName
    ? recallCache
        .map(r => ({ recall: r, score: similarity(productName, r.title) }))
        .filter(c => c.score >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.score - a.score)
    : [];

  const chargeMatch = charge
    ? candidates.find(c => recallContainsCharge(c.recall, charge))
    : null;

  // Zusätzlicher, vom Produktnamen unabhängiger Abgleich: manchmal ist der
  // Barcode bei Open Food Facts nicht hinterlegt (oder gar keiner angegeben),
  // die Chargennummer im Rückruf ist aber trotzdem eindeutig genug, um das
  // Produkt zu finden.
  const directChargeMatch = !chargeMatch && charge
    ? recallCache.find(r => recallContainsCharge(r, charge))
    : null;

  const treffer = chargeMatch ? chargeMatch.recall : directChargeMatch || null;

  res.json({
    barcode: barcode || null,
    charge: charge || null,
    produkt: product,
    status: treffer
      ? 'warn'
      : candidates.length
        ? 'moeglicher_treffer'
        : barcode && !product
          ? 'produkt_unbekannt'
          : 'kein_rueckruf_gefunden',
    treffer,
    trefferUeberChargeOhneNamen: !!directChargeMatch,
    aehnlicheKandidaten: candidates.slice(0, 3).map(c => ({
      titel: c.recall.title,
      grund: c.recall.reason,
      chargen: c.recall.lotNumbers,
      score: Math.round(c.score * 100) / 100
    }))
  });
});

app.listen(PORT, async () => {
  console.log(`Angelus-Vit-Backend läuft auf http://localhost:${PORT}`);
  await refreshRecalls();
  setInterval(refreshRecalls, RECALL_REFRESH_MS);
});
