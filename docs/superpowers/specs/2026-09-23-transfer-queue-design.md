# Transfer-Warteschlange mit Pause und Wiederherstellung

Stand: 2026-09-23 · Status: Design abgenommen, Umsetzung ausstehend

## Ziel

Heute ist nur sichtbar, was gerade läuft oder fertig ist: Jede Übertragung wird in
`transfers.ts` erst unmittelbar vor ihrem Start angelegt, der Status `queued` taucht nie
auf. Jeder Upload-, Download- und Kopier-Aufruf läuft in seiner eigenen Schleife, ohne
gemeinsames Limit.

Neu:

1. Alle **wartenden** Übertragungen sind sichtbar, gruppiert nach Auftrag.
2. Die Warteschlange lässt sich **global und pro Auftrag pausieren** und fortsetzen.
3. Die Warteschlange **übersteht einen Neustart** und wird beim nächsten Start angeboten.
4. Höchstens **4 Dateien gleichzeitig**, Aufträge kommen **reihum** dran.
5. Upload und Download fragen bei vorhandenen Zielen **einmal pro Auftrag**: überspringen
   oder überschreiben — wie es „Copy to…" heute schon tut.

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Wirkung von Pause | Stoppt nur den Nachschub; laufende Dateien laufen zu Ende. Kein Fortsetzen ab Byte. |
| Pause-Umfang | Global plus pro Auftrag. Nicht pro Datei. |
| Neustart | Wird gespeichert und beim Start angeboten. |
| Parallelität | 4 gleichzeitig, fest; faire Verteilung reihum über Aufträge. |
| Konflikte | Upload/Download/Copy fragen einmal pro Auftrag: Überspringen / Überschreiben / Abbrechen. |
| Ansatz | Hybrid: Auswahl-Aufträge vorab in Dateien zerlegt; Bucket-Sync bleibt ein Auftrag mit Zähler. |

## Aufbau

### Module (Main-Prozess)

- **`src/main/transferQueue.ts`** (neu) — der Scheduler als reine Logik: Aufträge, Plätze,
  faire Verteilung, Pause, Abbruch, Ereignisse. Führt selbst nichts aus, sondern ruft pro
  Datei einen injizierten Executor auf. Dadurch ohne S3 und ohne Electron testbar.
- **`src/main/queueStore.ts`** (neu) — Speichern und Wiederherstellen unter `userData/queue/`.
- **`src/main/transfers.ts`** (schrumpft) — nur noch das *Wie* einer einzelnen Datei
  (Upload, Download, Kopie) sowie die Auftrags-Builder, die eine Auswahl in Dateien zerlegen
  und die Ziele prüfen.

### Datenmodell

```
Job   id · kind: upload | download | copy | sync
      title  (z. B. "Upload 400 files → demo/photos/")
      Quelle/Ziel · conflict: skip | overwrite · paused · createdAt
Item  index · source · target · size
      status: queued | running | done | skipped | error | cancelled · error? · loaded
```

Zähler eines Auftrags (fertig, fehlgeschlagen, übersprungen, Bytes) werden aus seinen Items
**abgeleitet**, nicht separat gepflegt.

### Jeder Auftrag ist eine Item-Quelle

Der Scheduler fragt nur: „Gib mir deine nächste Datei."

- **Auswahl-Aufträge** (Upload, Download, Copy to…) antworten aus ihrer beim Anlegen
  erzeugten Liste.
- **Bucket-Sync** antwortet seitenweise aus der S3-Listung und holt die nächste Seite erst,
  wenn ihm ein Platz zugeteilt wird. Seine Dateien werden nie einzeln gespeichert.

Damit zählt auch der Sync gegen das gemeinsame Limit von 4, statt eigene Worker daneben
laufen zu lassen, und die faire Verteilung gilt für ihn automatisch.

## Ablaufsteuerung

- **Vergabe:** Höchstens 4 Items laufen. Wird ein Platz frei, geht der Scheduler reihum durch
  die Aufträge (in Erstellungsreihenfolge, beginnend nach dem zuletzt bedienten) und nimmt
  vom nächsten nicht pausierten Auftrag mit wartenden Items das nächste Item.
- **Global pausieren:** keine neue Vergabe; laufende Items laufen zu Ende. Anzeige:
  „Paused — 3 finishing".
- **Auftrag pausieren:** Der Auftrag wird bei der Vergabe übersprungen.
- **Fortsetzen:** vergibt sofort wieder freie Plätze.
- **Abbrechen:** auf Auftrags- oder Datei-Ebene. Laufende Items werden per `AbortController`
  gestoppt, wartende als `cancelled` markiert.
- **Fehler:** Ein fehlgeschlagenes Item bekommt `error` und blockiert nichts. Kurze
  Netzwerkaussetzer fängt das AWS SDK mit seinen eingebauten Wiederholungen ab.
- **Auftragsende:** Ist nichts mehr `queued` oder `running`, meldet der Scheduler
  `jobDone`. Die Oberfläche lädt die Tabelle neu, falls das Ziel der offene Ordner ist.
- **Bucket-Sync:** Die Prüfung „gleiche Größe überspringen" bleibt wie heute (Ziel wird zu
  Beginn einmal gelistet). Die **Gesamtgröße** liefert ein parallel laufendes `countPrefix`
  über die Quelle; bis es fertig ist, zeigt der Auftrag Bytes und Anzahl ohne Gesamtwert.
  Das ersetzt das heutige vollständige Vorab-Listen, das alle Keys im Speicher hält.
- **Fortschritt:** gedrosselt (~120 ms) pro Auftrag als Summen plus die höchstens 4
  laufenden Items einzeln — nie alle wartenden Items pro Tick.

## Speichern und Wiederherstellen

### Ablage

Unter `userData/queue/` (Verzeichnis `0700`, Dateien `0600`) pro Auftrag:

- **`<jobId>.job.json`** — Auftrag inklusive Item-Liste, **einmal** beim Anlegen geschrieben
  (atomar über temporäre Datei + `rename`, wie `accounts.json`).
- **`<jobId>.log`** — Anhängeprotokoll, eine Zeile pro Ereignis:
  - `<index> done|skipped|error|cancelled [Meldung]` — ein Item ist abgeschlossen
  - `paused` / `resumed` — Pausenzustand des Auftrags durch den Nutzer
  - `mark <key>` — nur Sync: Key, bis zu dem lückenlos alles erledigt ist

Eine unvollständige letzte Zeile (Absturz beim Schreiben) wird beim Einlesen ignoriert. Ist
ein Auftrag vollständig abgeschlossen oder abgebrochen, werden beide Dateien gelöscht.
Gespeichert werden **keine** Zugangsdaten, nur die Verbindungs-ID.

### Beim Start

Unfertige Aufträge werden eingelesen und erscheinen als Leiste oben im Transfer-Panel (kein
blockierendes Fenster):

> *3 jobs with 312 pending transfers from last time — **Resume** / **Discard***

Bis zur Wahl bleiben alle wiederhergestellten Aufträge pausiert. **Resume** setzt nur die
Aufträge fort, die beim Beenden **nicht** vom Nutzer pausiert waren; vom Nutzer pausierte
bleiben pausiert. **Discard** löscht die Dateien.

Items, die beim Beenden `running` waren, kommen als `queued` zurück und beginnen bei 0.
Neue Aufträge, die angelegt werden, bevor über die Leiste entschieden ist, laufen
unabhängig davon normal.

### Prüfung bei Ausführung, nicht beim Wiederherstellen

- **Verbindung gelöscht:** Der ganze Auftrag scheitert sofort mit dieser Meldung, statt pro
  Item einen eigenen Fehler zu erzeugen.
- **Upload-Quelldatei fehlt:** Dieses Item scheitert mit „nicht mehr vorhanden", der Rest läuft.
- **Download-Ziel:** Der lokale Pfad wird bei jeder Ausführung neu über `localPathFor(destDir,
  rel)` berechnet. Gespeichert werden `destDir` und der relative Pfad, nie ein fertiger
  absoluter Zielpfad — die Queue-Datei darf kein Weg sein, einen Download aus dem gewählten
  Ordner hinauszuschreiben.
- **Konflikte nach Neustart:** Bei `conflict: skip` werden die verbleibenden Items vor dem
  Fortsetzen erneut geprüft (die Momentaufnahme vom Anlegen ist veraltet). Bei `overwrite`
  entfällt die Prüfung.

### Bucket-Sync fortsetzen

Der Sync speichert keine Item-Liste, sondern die Marke `mark <key>`: den Key, bis zu dem
lückenlos alles erledigt ist. Beim Fortsetzen startet die Quell-Listung mit
`StartAfter: <key>`. Durch die parallelen Plätze werden dabei höchstens die Items erneut
übertragen, die beim Beenden liefen (≤ 4) — unabhängig von der Konflikt-Einstellung.

### Beenden der App

Kein Warndialog: Verloren geht nur der Fortschritt der gerade laufenden Items.

### Vertrauensgrenze

Die Queue-Dateien liegen im selben Benutzerverzeichnis wie `accounts.json`. Wer dort
schreiben kann, kann auch Verbindungen umleiten; die Queue erweitert diese Grenze nicht. Sie
beschränkt sich darauf, keine absoluten Download-Zielpfade zu vertrauen (siehe oben), und
Wiederherstellen setzt ein ausdrückliches **Resume** voraus.

## Konflikte beim Anlegen

Ablauf für Upload, Download und „Copy to…": Auswahl zerlegen → Ziele prüfen → bei Treffern
einmal fragen → erst dann entsteht der Auftrag. Ohne Treffer startet er ohne Dialog.

Dialog (bestehender `ConflictDialog`, für alle drei Wege):

> *12 of 400 objects already exist at the destination — e.g. `photos/2024/a.jpg`, … —
> **Skip existing** / **Overwrite** / **Cancel***

Bei **Skip existing** werden die Treffer sofort als `skipped` markiert und bleiben im Auftrag
sichtbar.

### Prüfstrategie

Geprüft wird nur, was die Auswahl betrifft:

- **ausgewählter Ordner** → nur dessen Ziel-Präfix listen;
- **einzelne Datei** → ein `HEAD` auf genau diesen Key;
- **Download** → lokal per `stat` auf die Pfade aus `localPathFor`, also genau die, die
  geschrieben würden.

Das behebt nebenbei einen Fehler im heutigen `planCopy`: Es listet das **komplette**
Ziel-Präfix, sodass eine einzelne Datei in die Wurzel eines Buckets mit einer Million
Objekten rund 1.000 LIST-Requests auslöst.

Die Prüfung ist eine Momentaufnahme zum Zeitpunkt des Anlegens. Bucket-Sync behält seine
Checkbox „gleiche Größe überspringen" und bekommt keinen Dialog.

## Oberfläche

Beschriftungen bleiben englisch wie der Rest der App.

```
Transfers   2 active · 346 waiting · 1 failed        [⏸ Pause all]  [Clear finished]
▾ ⬆ Upload 400 files → demo/photos/        ▓▓▓▓▓░░░░░  120/400 · 5.3 MB/s    ⏸  ✕
     ⟳ img-0121.jpg  ▓▓▓▓░░  64%                                                   ✕
     ✗ img-0077.jpg  Access Denied
     · img-0123.jpg … img-0130.jpg                         + 270 more waiting
▸ ⬇ Download 50 files → ~/Downloads        paused · 50 waiting        Show in folder ▶ ✕
▸ ⧉ Copy contents demo → backup            2.1 GB / 8.4 GB · 3,120 objects       ⏸  ✕
```

- Jeder Auftrag ist eine aufklappbare Zeile mit Summen, Tempo, Pause/Fortsetzen und Abbrechen.
  Ein Auftrag mit genau einem Item erscheint als einfache Zeile.
- Aufgeklappt: laufende Items einzeln, fehlgeschlagene mit Grund, dann die nächsten
  wartenden (höchstens 8, danach „+ N more waiting"). Fertige Items nur als Zahl.
- **„Show in folder"** pro Download-Auftrag öffnet dessen Zielordner und ersetzt das
  Doppelklicken auf einzelne fertige Dateien. `shell:showItem` erlaubt künftig nur noch
  Zielordner bekannter Download-Aufträge.
- Wiederherstellen-Hinweis als Leiste oben im Panel.

## IPC

Zweistufig, damit der Renderer keine Item-Listen hin- und herschickt:

1. **`queue:plan(Beschreibung)`** — Main zerlegt die Auswahl, prüft die Ziele, **behält** die
   Item-Liste und antwortet `{ planId, total, conflicts, sample }`. Es gibt höchstens einen
   offenen Plan; ein neuer ersetzt den alten.
2. **`queue:enqueue(planId, 'skip' | 'overwrite')`** — legt den Auftrag an und gibt die
   `jobId` zurück.

Steuerung: `queue:pauseAll`, `queue:resumeAll`, `queue:pauseJob`, `queue:resumeJob`,
`queue:cancelJob`, `queue:cancelItem`, `queue:clearFinished`, `queue:list`,
`queue:restore('resume' | 'discard')`, `queue:revealJob`.

Ereignisse: `queue:update` (gedrosselte Auftrags-Snapshots), `queue:jobDone` mit Art und Ziel
des Auftrags (Verbindung, Bucket, Präfix) — genug, damit die Oberfläche entscheiden kann, ob
der offene Ordner neu geladen werden muss.

Alle Kanäle laufen durch `wrap()` mit Absenderprüfung und Argumentvalidierung. Die
bisherigen `transfer:*`-Kanäle und der Typ `Transfer` entfallen zugunsten von
`TransferJob`/`TransferItem`-Ansichten in `src/shared/types.ts`.

## Tests

Vitest, gefälscht wird nur die Netzwerk- bzw. Dateisystemgrenze.

- **`transferQueue`** mit injiziertem Executor: Limit 4 wird nie überschritten; ein später
  angelegter Auftrag bekommt den nächsten freien Platz (Fairness); globale Pause startet
  nichts Neues, Laufendes endet regulär; Auftrags-Pause überspringt nur diesen Auftrag;
  Abbruch von Auftrag und einzelnem Item; ein Fehler blockiert den Auftrag nicht; `jobDone`
  genau einmal; eine Lazy-Quelle wird nur bei freiem Platz abgefragt.
- **`queueStore`** auf einem temporären Verzeichnis: `job.json` wird genau einmal
  geschrieben; Wiederherstellen ergibt die verbleibenden Items; unvollständige letzte
  Log-Zeile wird ignoriert; `running` kommt als `queued` zurück; vom Nutzer pausierte
  Aufträge bleiben nach **Resume** pausiert; abgeschlossene Aufträge löschen ihre Dateien;
  Dateirechte `0600`.
- **Konfliktprüfung** mit gefälschtem S3, das Requests zählt: eine einzelne Datei in einen
  großen Bucket kostet genau einen `HEAD` und keinen `LIST` (Regressionstest für den
  `planCopy`-Fehler); ein Ordner listet nur sein Präfix; Download-Konflikte auf einem
  temporären Verzeichnis.
- **`localPathFor`** bekommt echte Tests (bisher nur im Scratchpad geprüft).
- **Ende-zu-Ende** gegen den lokalen Fake-S3-Server, erweitert um PUT/GET/HEAD/Copy: Queue
  sichtbar, Pause und Fortsetzen, Neustart mit Wiederherstellen.

## Nicht Teil dieses Umbaus

- Knopf „Fehlgeschlagene erneut versuchen"
- Fortsetzen ab Byte (Multipart-Resume, Range-Downloads)
- Einstellbare Parallelität
- Pause pro Datei
- Konfliktoption „beide behalten"
- Warndialog beim Beenden
