# Angelus Vit – Backend-Prototyp

Verbindet zwei echte, kostenlose Datenquellen:

- **Barcode → Produktname**: [Open Food Facts](https://world.openfoodfacts.org) (offizielle öffentliche API, kein Key nötig)
- **Rückrufdaten**: die offiziellen RSS-Feeds von [lebensmittelwarnung.de](https://www.lebensmittelwarnung.de), geladen über das Community-Tool `@maschinenlesbar.org/lebensmittelwarnung-cli`

Der Abgleich zwischen Barcode-Produktname und Rückruf-Titel läuft über eine einfache Textähnlichkeit (Bigramm-Vergleich), weil Rückrufe nach Produktname/Hersteller gemeldet werden – nicht nach Barcode.

## ⚠️ Rechtlicher Hinweis (bitte vor Weiternutzung lesen)

1. **Lizenz der CLI (AGPL-3.0):** Das Tool, das die RSS-Feeds parst, ist AGPL-lizenziert. Wird eine (modifizierte) Version als Netzwerkdienst betrieben, verlangt die AGPL, den Quellcode den Nutzer:innen des Dienstes zugänglich zu machen – es sei denn, man erwirbt die kommerzielle Lizenz des Anbieters (Kontakt steht im Repo). Für einen Prototyp/internen Test unkritisch, für ein kommerzielles Produkt vorher klären.
2. **Nutzungsbedingungen von lebensmittelwarnung.de:** Das Portal erlaubt laut eigener Angabe die Weiterverwendung seiner Inhalte nur **unverändert, vollständig und mit Quellenangabe** – explizit **keine** Teilnutzung und **kein** Mischen mit anderen Quellen. Das genaue Matching-Feature dieses Prototyps (Kombination mit Open-Food-Facts-Daten) berührt das direkt. Das solltest du von einer Anwältin/einem Anwalt prüfen lassen oder eine explizite Nutzungserlaubnis beim BVL einholen, bevor daraus ein Produkt wird.

Dieser Prototyp dient ausschließlich dazu, die technische Machbarkeit zu testen.

## Voraussetzungen

- Node.js Version 18 oder neuer
- Internetverbindung (ruft externe APIs auf)

## Installation & Start

```bash
cd angelus-vit-backend
npm install
npm start
```

Der Server läuft danach unter `http://localhost:3001`. Beim Start lädt er einmalig die aktuellen Rückrufe und danach automatisch alle 20 Minuten neu.

## Auf dem iPhone testen (im selben WLAN)

Der Server liefert die App jetzt auch direkt selbst aus (Ordner `public/index.html`), damit du sie ohne Datei-Transfer aufs Handy bekommst.

1. **Computer und iPhone müssen im selben WLAN sein.**
2. Lokale Netzwerk-Adresse deines Computers herausfinden:
   - **Mac:** Systemeinstellungen → WLAN → Details → dort steht die IP-Adresse (z. B. `192.168.1.42`)
   - **Windows:** Eingabeaufforderung öffnen, `ipconfig` eingeben, die Zeile „IPv4-Adresse“ unter deinem WLAN-Adapter ablesen
3. Server wie gewohnt starten (`npm start`) – Terminal-Fenster offen lassen.
4. Auf dem iPhone Safari öffnen und genau diese Adresse eintippen: `http://<deine-IP>:3001` (Beispiel: `http://192.168.1.42:3001`)
5. Die App öffnet sich und verbindet sich automatisch mit dem richtigen Backend – die Adresse muss nicht manuell eingetragen werden.

**Falls die Seite auf dem iPhone nicht lädt:** Meist blockiert das die Firewall des Computers (Verbindungen aus dem lokalen Netzwerk). Bei macOS unter Systemeinstellungen → Netzwerk → Firewall kurz prüfen/testweise deaktivieren; bei Windows die Firewall-Freigabe für Node.js bestätigen, falls ein Dialog dazu erscheint.

## Als "App" fürs Handy einrichten (für Pitches / zum Zeigen)

Die App ist als **Progressive Web App (PWA)** vorbereitet: eigenes Icon, läuft im Vollbild ohne Safari-Adressleiste, kein App Store nötig. Damit das auf jedem Handy funktioniert – nicht nur im eigenen WLAN – muss das Backend aber online erreichbar sein, nicht nur auf deinem Laptop.

### 1. Backend online hosten (kostenlos, z. B. Render.com)

1. Kostenlosen Account auf [render.com](https://render.com) anlegen
2. Den Ordner `angelus-vit-backend` in ein GitHub-Repository laden (GitHub-Account anlegen, neues Repository erstellen, Dateien per Drag & Drop über die GitHub-Weboberfläche hochladen – kein Kommandozeilen-Git nötig)
3. In Render: "New Web Service" → das GitHub-Repository auswählen → Build-Befehl `npm install`, Start-Befehl `npm start` → Deploy
4. Render gibt dir eine öffentliche URL (z. B. `https://angelus-vit-backend.onrender.com`)

Hinweis: Der kostenlose Render-Tarif "schläft" nach Inaktivität ein – der erste Aufruf nach einer Pause kann dann ein paar Sekunden dauern. Für einen Pitch: die Seite kurz vorher einmal selbst öffnen, damit sie "aufgewacht" ist.

### 2. Als App installieren

1. Die Render-URL auf dem iPhone in Safari öffnen
2. Teilen-Symbol antippen → "Zum Home-Bildschirm"
3. Fertig – eigenes Icon auf dem Homescreen, öffnet sich im Vollbild wie eine echte App

Diesen Link kannst du auch an andere schicken – jede:r kann ihn genauso auf dem eigenen iPhone installieren.

### Noch "echter" wirken lassen (optional, mehr Aufwand)

Für eine App, die wirklich im App Store landet oder per TestFlight verteilt wird, bräuchtest du zusätzlich einen Mac mit Xcode, einen Apple-Developer-Account (99 $/Jahr) und ein Tool wie **Capacitor**, das den bestehenden HTML/JS-Code in eine native App-Hülle packt. Für den Pitch-Zweck ist die PWA-Lösung oben aber meist ausreichend und deutlich schneller umsetzbar.

## Endpunkte

### `GET /api/status`
Zeigt, wann zuletzt Rückrufe geladen wurden und ob das geklappt hat.

### `GET /api/recalls`
Gibt alle aktuell im Backend gecachten Rückrufe zurück (Rohdaten von lebensmittelwarnung.de).

### `GET /api/lookup?barcode=4104420001112`
Löst einen Barcode über Open Food Facts zu Produktname/Marke auf.

```bash
curl "http://localhost:3001/api/lookup?barcode=4311501867658"
```

### `POST /api/check`
Prüft einen Barcode (+ optional Chargennummer) gegen die aktuellen Rückrufe.

```bash
curl -X POST http://localhost:3001/api/check \
  -H "Content-Type: application/json" \
  -d '{"barcode": "4311501867658", "charge": "L2456A"}'
```

Antwort z. B.:
```json
{
  "barcode": "4311501867658",
  "produkt": { "name": "...", "brand": "..." },
  "status": "kein_rueckruf_gefunden",
  "treffer": null,
  "aehnlicheKandidaten": []
}
```

## Bekannte Einschränkungen dieses Prototyps

- **Matching-Genauigkeit ungetestet**: Der Ähnlichkeits-Schwellenwert (`SIMILARITY_THRESHOLD` in `server.js`) ist ein Startwert, kein validierter Wert. Vor echtem Einsatz mit historischen Rückrufdaten testen (wie viele echte Treffer werden erkannt, wie viele Fehlalarme entstehen).
- **Nur Lebensmittel-Rückrufe** werden geladen (`--type lebensmittel`); Kosmetik/Bedarfsgegenstände sind in der CLI ebenfalls filterbar, falls relevant.
- **Keine Persistenz**: Der Rückruf-Cache liegt nur im Arbeitsspeicher. Für die "nachträgliche Warnung" (gekaufte Produkte, die später zurückgerufen werden) braucht ihr zusätzlich eine Datenbank, die gescannte Produkte pro Nutzer:in speichert und bei jedem Refresh dagegen abgleicht.
- **Kein Push**: Aktuell muss die App aktiv einen Endpunkt abfragen. Für echte proaktive Warnungen braucht es zusätzlich Push-Benachrichtigungen (z. B. Firebase Cloud Messaging).

## Nächste sinnvolle Schritte

1. Datenbank ergänzen (z. B. SQLite) für gescannte Produkte pro Nutzer:in
2. Bei jedem Rückruf-Refresh automatisch gegen gespeicherte Nutzer-Produkte abgleichen → Basis für die nachträgliche Warnung
3. Matching-Schwellenwert mit echten Daten kalibrieren
4. Den HTML-Prototyp (Frontend) an dieses Backend anschließen, statt der Mock-Daten
5. Rechtsfragen (siehe oben) klären, bevor es produktiv geht
