/* Angelus Vit – Schutzcheck
 *
 * Bewertet ein Produkt gegen die Regeltabelle (regeln.json) und liefert eine
 * Vorsichtsstufe: rot, gelb, gruen oder unbekannt.
 *
 * WICHTIG – Datenschutz: Dieses Modul läuft vollständig auf dem Gerät. Die
 * gewählte Empfindlichkeit wird NICHT an den Server geschickt und liegt nur in
 * localStorage. Der Server liefert ausschließlich Produktfakten und die für
 * alle identische Regeltabelle; er erfährt nicht, welche Stufe jemand gewählt
 * hat und damit auch nichts über dessen Gesundheitszustand.
 *
 * Grundhaltung: Der Schutzcheck verbietet nichts. Er nennt ein Risiko und
 * seinen Grund, die Entscheidung bleibt beim Menschen. Deshalb gibt es zu
 * jeder Farbe immer einen Klartext dazu.
 */

(function (global) {
  'use strict';

  var SPEICHER_SCHLUESSEL = 'angelusvit.empfindlichkeit';
  var RANG = { unbekannt: 0, gruen: 1, gelb: 2, rot: 3 };

  var regelCache = null;

  // -------------------------------------------------------------------- Setup

  var EMPFINDLICHKEITEN = [
    { id: 'standard',       label: 'Standard',          hinweis: 'Grundschutz vor den wichtigsten Erregern' },
    { id: 'streng',         label: 'Streng',            hinweis: 'Für stark geschwächte Abwehr' },
    { id: 'schwangerschaft',label: 'Schwangerschaft',   hinweis: 'Zusätzlich Alkohol, Leber und Quecksilber' },
    { id: 'saeugling',      label: 'Säugling im Haushalt', hinweis: 'Zusätzlich Honig' }
  ];

  // Bewusst ohne Diagnoseabfrage: Wer „streng" wählt, muss keinen Grund nennen.
  function getEmpfindlichkeit() {
    try {
      var wert = global.localStorage.getItem(SPEICHER_SCHLUESSEL);
      return wert || 'standard';
    } catch (e) {
      return 'standard'; // privater Modus o. Ä. – Standard ist die sichere Annahme
    }
  }

  function setEmpfindlichkeit(id) {
    try {
      global.localStorage.setItem(SPEICHER_SCHLUESSEL, id);
    } catch (e) { /* nicht speicherbar, gilt dann nur für diese Sitzung */ }
  }

  async function ladeRegeln(basis) {
    if (regelCache) return regelCache;
    var pfad = (basis || '') + '/regeln.json';
    var res = await fetch(pfad, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Regeltabelle nicht ladbar (' + res.status + ')');
    regelCache = await res.json();
    return regelCache;
  }

  // ---------------------------------------------------------------- Bewertung

  function alsListe(wert) {
    if (!wert) return [];
    return Array.isArray(wert) ? wert : [wert];
  }

  // Kategorien und Labels sind Tags wie "en:soft-cheeses" – exakter Vergleich.
  function tagTrifft(produktTags, regelTags) {
    if (!regelTags || !regelTags.length) return false;
    var vorhanden = alsListe(produktTags).map(function (t) {
      return String(t).toLowerCase();
    });
    return regelTags.some(function (gesucht) {
      return vorhanden.indexOf(String(gesucht).toLowerCase()) !== -1;
    });
  }

  // Zutatentext ist Fließtext – Teilstringsuche, kleingeschrieben.
  function zutatTrifft(zutatentext, muster) {
    if (!muster || !muster.length || !zutatentext) return false;
    var text = String(zutatentext).toLowerCase();
    return muster.some(function (m) {
      return text.indexOf(String(m).toLowerCase()) !== -1;
    });
  }

  function bedingungErfuellt(produkt, bed) {
    if (!bed) return false;
    return tagTrifft(produkt.kategorien, bed.kategorien) ||
           tagTrifft(produkt.labels, bed.labels) ||
           zutatTrifft(produkt.zutaten, bed.zutaten);
  }

  /* Liefert:
   *   { stufe, treffer: [...], datenlage, empfindlichkeit }
   *
   * datenlage unterscheidet drei Fälle, und diese Unterscheidung ist der
   * wichtigste Teil der ganzen Funktion:
   *   'keine'  – über das Produkt ist nichts bekannt. Das ist NICHT grün.
   *              Fehlende Daten als Entwarnung auszugeben wäre der gefährlichste
   *              Fehler, den dieser Code machen könnte.
   *   'duenn'  – nur ein Name, keine Kategorie und keine Zutaten.
   *   'gut'    – Kategorien und/oder Zutaten liegen vor.
   */
  function bewerte(produkt, regelwerk, empfindlichkeit) {
    empfindlichkeit = empfindlichkeit || getEmpfindlichkeit();
    produkt = produkt || {};

    var hatKategorien = alsListe(produkt.kategorien).length > 0;
    var hatZutaten = !!(produkt.zutaten && String(produkt.zutaten).trim());
    var datenlage = (hatKategorien || hatZutaten) ? 'gut'
                  : (produkt.name ? 'duenn' : 'keine');

    if (datenlage !== 'gut') {
      return {
        stufe: 'unbekannt',
        treffer: [],
        datenlage: datenlage,
        empfindlichkeit: empfindlichkeit
      };
    }

    var treffer = [];
    var entwarnungen = [];
    var regeln = (regelwerk && regelwerk.regeln) || [];

    for (var i = 0; i < regeln.length; i++) {
      var regel = regeln[i];
      var stufe = regel.stufe && regel.stufe[empfindlichkeit];
      if (!stufe) continue;                               // gilt für diese Stufe nicht
      if (!bedingungErfuellt(produkt, regel.trifft)) continue;

      // Ausnahme greift: Die Regel hätte zugeschlagen, tut es aber nicht.
      // Das wird festgehalten statt stillschweigend verworfen – wer "Rohmilch"
      // auf der Packung liest und eine grüne Ampel sieht, misstraut sonst
      // zu Recht der Anzeige.
      if (bedingungErfuellt(produkt, regel.ausser)) {
        if (regel.entwarnung) {
          entwarnungen.push({ id: regel.id, titel: regel.titel, text: regel.entwarnung });
        }
        continue;
      }

      treffer.push({
        id: regel.id,
        titel: regel.titel,
        stufe: stufe,
        grund: regel.grund,
        pruefen: regel.pruefen || null,
        sicherheit: regel.sicherheit || 'mittel'
      });
    }

    treffer.sort(function (a, b) { return RANG[b.stufe] - RANG[a.stufe]; });

    var hoechste = treffer.length ? treffer[0].stufe : 'gruen';

    return {
      stufe: hoechste,
      treffer: treffer,
      entwarnungen: entwarnungen,
      datenlage: datenlage,
      empfindlichkeit: empfindlichkeit
    };
  }

  // ------------------------------------------------------------- Darstellung

  var TEXTE = {
    rot:       { label: 'Rot',       kurz: 'Für dich nicht geeignet' },
    gelb:      { label: 'Gelb',      kurz: 'Bitte auf der Packung nachsehen' },
    gruen:     { label: 'Grün',      kurz: 'Keine bekannte Risikogruppe' },
    unbekannt: { label: 'Unbekannt', kurz: 'Keine Produktdaten vorhanden' }
  };

  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderAmpel(ergebnis) {
    var t = TEXTE[ergebnis.stufe] || TEXTE.unbekannt;
    var html = '<div class="schutzcheck sc-' + ergebnis.stufe + '">';
    html += '<div class="sc-kopf"><span class="sc-punkt"></span>' +
            '<span class="sc-titel">Schutzcheck: ' + escape(t.label) + '</span></div>';
    html += '<p class="sc-kurz">' + escape(t.kurz) + '</p>';

    if (ergebnis.stufe === 'unbekannt') {
      html += '<p class="sc-hinweis">Zu diesem Produkt liegen keine Zutaten- oder ' +
              'Kategoriedaten vor. Das ist keine Entwarnung – es heißt nur, dass ' +
              'nichts geprüft werden konnte.</p>';
    } else if (!ergebnis.treffer.length) {
      html += '<p class="sc-hinweis">Dieses Produkt fällt in keine der bekannten ' +
              'Risikogruppen. Das ersetzt keinen Blick auf die Packung.</p>';
    } else {
      html += '<ul class="sc-liste">';
      for (var i = 0; i < ergebnis.treffer.length; i++) {
        var tr = ergebnis.treffer[i];
        html += '<li class="sc-treffer sc-t-' + tr.stufe + '">';
        html += '<span class="sc-grund">' + escape(tr.grund) + '</span>';
        if (tr.pruefen) {
          html += '<span class="sc-pruefen">' + escape(tr.pruefen) + '</span>';
        }
        if (tr.sicherheit === 'niedrig') {
          html += '<span class="sc-unsicher">Erfahrungswert – steht nicht in den Produktdaten</span>';
        }
        html += '</li>';
      }
      html += '</ul>';
    }

    // Entwarnungen stehen auch dann da, wenn die Ampel grün ist – sie erklären,
    // warum ein auffälliger Hinweis auf der Packung hier nicht zählt.
    var ew = ergebnis.entwarnungen || [];
    for (var k = 0; k < ew.length; k++) {
      html += '<p class="sc-entwarnung">' + escape(ew[k].text) + '</p>';
    }

    html += '<div class="sc-fuss">Einstellung: ' +
            escape(labelFuer(ergebnis.empfindlichkeit)) +
            ' · Bewertung erfolgt auf diesem Gerät</div>';
    html += '</div>';
    return html;
  }

  function labelFuer(id) {
    for (var i = 0; i < EMPFINDLICHKEITEN.length; i++) {
      if (EMPFINDLICHKEITEN[i].id === id) return EMPFINDLICHKEITEN[i].label;
    }
    return id;
  }

  // Produktfelder aus der Backend-Antwort einsammeln. Tolerant gegenüber
  // beiden Formen: angereichertes /api/check oder nackte Open-Food-Facts-Daten.
  function ausAntwort(produkt) {
    if (!produkt) return {};
    return {
      name: produkt.name || produkt.product_name || null,
      kategorien: produkt.kategorien || produkt.categories_tags || [],
      labels: produkt.labels || produkt.labels_tags || [],
      zutaten: produkt.zutaten || produkt.ingredients_text_de ||
               produkt.ingredients_text || ''
    };
  }

  // ------------------------------------------------- Einhängen mit einer Zeile

  /* Lädt die Regeln, bewertet und hängt die Ampel an ein Element an.
   * Fehler werden bewusst geschluckt: Wenn der Schutzcheck nicht lädt, soll
   * die Rückrufprüfung trotzdem sichtbar bleiben – sie ist die wichtigere
   * der beiden Funktionen. */
  async function anzeigen(produktRoh, zielElement, basis) {
    if (!zielElement) return null;
    try {
      var regeln = await ladeRegeln(basis);
      var ergebnis = bewerte(ausAntwort(produktRoh), regeln, getEmpfindlichkeit());
      zielElement.insertAdjacentHTML('beforeend', renderAmpel(ergebnis));
      return ergebnis;
    } catch (e) {
      if (global.console) console.warn('[schutzcheck] nicht verfügbar:', e.message);
      return null;
    }
  }

  /* Auswahlfeld für die Empfindlichkeit. Fragt bewusst keine Diagnose ab –
   * wer "streng" wählt, muss keinen Grund angeben, und der Server erfährt
   * die Auswahl nicht. */
  function renderEinstellung(zielElement, beiAenderung) {
    if (!zielElement) return;
    var aktuell = getEmpfindlichkeit();
    var html = '<div class="sc-einstellung"><label for="sc-empf">Empfindlichkeit</label>' +
               '<select id="sc-empf">';
    for (var i = 0; i < EMPFINDLICHKEITEN.length; i++) {
      var e = EMPFINDLICHKEITEN[i];
      html += '<option value="' + e.id + '"' + (e.id === aktuell ? ' selected' : '') +
              '>' + escape(e.label) + '</option>';
    }
    html += '</select><p class="sc-einstellung-hinweis"></p></div>';
    zielElement.innerHTML = html;

    var select = zielElement.querySelector('#sc-empf');
    var hinweis = zielElement.querySelector('.sc-einstellung-hinweis');

    function zeigeHinweis() {
      for (var j = 0; j < EMPFINDLICHKEITEN.length; j++) {
        if (EMPFINDLICHKEITEN[j].id === select.value) {
          hinweis.textContent = EMPFINDLICHKEITEN[j].hinweis +
            ' · Diese Einstellung bleibt auf dem Gerät.';
          return;
        }
      }
    }
    zeigeHinweis();

    select.addEventListener('change', function () {
      setEmpfindlichkeit(select.value);
      zeigeHinweis();
      if (typeof beiAenderung === 'function') beiAenderung(select.value);
    });
  }

  // --------------------------------------------------------------- Styling
  // Das Modul bringt sein eigenes Stylesheet mit, damit beim Einbau nur eine
  // Script-Zeile nötig ist und die index.html nicht angefasst werden muss.
  var CSS = [
    '.schutzcheck{margin-top:12px;border:1px solid var(--line,#d8d8d8);border-radius:10px;padding:14px 16px;background:var(--card,#fff)}',
    '.schutzcheck .sc-kopf{display:flex;align-items:center;gap:9px;font-weight:600}',
    '.schutzcheck .sc-punkt{width:13px;height:13px;border-radius:50%;flex:0 0 auto}',
    '.sc-rot .sc-punkt{background:#c0392b}.sc-gelb .sc-punkt{background:#d79a1e}',
    '.sc-gruen .sc-punkt{background:#2e7d52}.sc-unbekannt .sc-punkt{background:#8a8a8a}',
    '.sc-rot{border-left:4px solid #c0392b}.sc-gelb{border-left:4px solid #d79a1e}',
    '.sc-gruen{border-left:4px solid #2e7d52}.sc-unbekannt{border-left:4px solid #8a8a8a}',
    '.schutzcheck .sc-kurz{margin:7px 0 0;font-size:14.5px}',
    '.schutzcheck .sc-hinweis{margin:7px 0 0;font-size:13.5px;opacity:.78;line-height:1.5}',
    '.schutzcheck .sc-liste{list-style:none;margin:11px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}',
    '.schutzcheck .sc-treffer{padding-left:11px;border-left:2px solid #ddd}',
    '.sc-t-rot{border-left-color:#c0392b}.sc-t-gelb{border-left-color:#d79a1e}',
    '.schutzcheck .sc-grund{display:block;font-size:14px;font-weight:500}',
    '.schutzcheck .sc-pruefen{display:block;font-size:13px;opacity:.78;margin-top:3px;line-height:1.5}',
    '.schutzcheck .sc-unsicher{display:block;font-size:11.5px;opacity:.62;margin-top:4px;font-style:italic}',
    '.schutzcheck .sc-entwarnung{margin:11px 0 0;font-size:13px;opacity:.82;line-height:1.5;padding-left:11px;border-left:2px solid #2e7d52}',
    '.schutzcheck .sc-fuss{margin-top:12px;padding-top:9px;border-top:1px solid var(--line,#eee);font-size:11.5px;opacity:.6}',
    '.sc-einstellung{display:flex;flex-direction:column;gap:6px;margin:10px 0}',
    '.sc-einstellung label{font-size:13px;font-weight:600}',
    '.sc-einstellung select{padding:9px 10px;border-radius:8px;border:1px solid var(--line,#ccc);font-size:15px;background:var(--card,#fff);color:inherit}',
    '.sc-einstellung-hinweis{margin:0;font-size:12.5px;opacity:.7;line-height:1.45}'
  ].join('');

  function styleEinfuegen() {
    if (!global.document || global.document.getElementById('sc-style')) return;
    var el = global.document.createElement('style');
    el.id = 'sc-style';
    el.textContent = CSS;
    global.document.head.appendChild(el);
  }
  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', styleEinfuegen);
    } else {
      styleEinfuegen();
    }
  }

  global.Schutzcheck = {
    EMPFINDLICHKEITEN: EMPFINDLICHKEITEN,
    ladeRegeln: ladeRegeln,
    getEmpfindlichkeit: getEmpfindlichkeit,
    setEmpfindlichkeit: setEmpfindlichkeit,
    bewerte: bewerte,
    renderAmpel: renderAmpel,
    ausAntwort: ausAntwort,
    anzeigen: anzeigen,
    renderEinstellung: renderEinstellung
  };

})(window);
