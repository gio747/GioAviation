# GioAviation.aero — guida alla pubblicazione

Sito statico, nessuna build necessaria: 3 pagine HTML + 1 foglio di stile. Pronto per Cloudflare Pages, completamente indipendente da qualsiasi altro tuo account (Vercel/NutriCalc esclusi di proposito).

## Cosa contiene questa cartella

- `index.html` — Home, con anteprima della libreria risorse (3 mental map 747-400 già esistenti, protette da gate email: sono ancora file placeholder in attesa dei PDF veri)
- `credenziali.html` — Pagina credenziali
- `contatti.html` — Pagina contatti, con modulo collegato a Formspree (da configurare, vedi sotto) e email diretta di riserva
- `assets/style.css` — sistema di stile condiviso dalle tre pagine
- `assets/gate.js` — logica del modulo di sblocco email sui download
- `resources/` — i tre documenti placeholder protetti dal gate
- `wrangler.jsonc` + `src/index.js` — configurazione del Worker Cloudflare (vedi Passo 3): necessari perché il sito è finito su un Worker con asset statici, non su un progetto Pages classico
- `functions/api/subscribe.js` — versione precedente, pensata per Pages Functions, ora inutilizzata (vedi Passo 3)

## Passo 1 — Pubblicare su Cloudflare Pages (15 minuti)

**Correzione importante:** la modalità "Upload assets" (drag&drop diretto da dashboard) NON supporta la cartella `functions/`, è una limitazione documentata di Cloudflare, non un errore tuo. Se il sito include il gate email (e lo include), va pubblicato collegando un repository Git, non con l'upload diretto.

1. Crea un account gratuito su [github.com](https://github.com) se non lo hai già (puoi anche usare il tuo account esistente, basta un repository nuovo e separato).
2. Crea un nuovo repository, vuoto, ad esempio `gioaviation-site`.
3. Nella pagina del repository su GitHub, usa **Add file → Upload files** e trascina dentro tutto il contenuto della cartella `gioaviation-site` (inclusi i sottocartelle `assets/`, `functions/`, `resources/` — i browser moderni mantengono la struttura delle cartelle nel trascinamento). Conferma il commit.
4. Vai su [pages.cloudflare.com](https://pages.cloudflare.com) e crea un account gratuito (nuovo, separato da tutto il resto).
5. Nel dashboard scegli **Workers & Pages → Create → Pages → Connect to Git**, autorizza l'accesso a GitHub e seleziona il repository appena creato.
6. Nelle impostazioni di build: lascia vuoto il **Build command**, e come **Build output directory** metti `/` (la root del repository).
7. Avvia il deploy. Cloudflare ti assegna un indirizzo tipo `gioaviation-site.pages.dev`, e questa volta la cartella `functions/` viene riconosciuta correttamente.

Ogni volta che vuoi aggiornare il sito in futuro, basta caricare i file modificati sullo stesso repository GitHub (sempre da "Add file → Upload files", sovrascrivendo i file esistenti): Cloudflare ripubblica automaticamente ad ogni commit.

## Passo 2 — Collegare il dominio .aero

Una volta registrato il dominio (vedi la lista registrar di cui abbiamo già parlato):

1. Nel progetto Cloudflare Pages, vai su **Custom domains → Set up a custom domain**.
2. Inserisci `gioaviation.aero` (e se vuoi anche `www.gioaviation.aero`).
3. Cloudflare ti indica i record DNS da impostare presso il tuo registrar. Se il dominio viene gestito direttamente su Cloudflare (puoi anche trasferire la gestione DNS lì gratuitamente), il collegamento è automatico.

Il sito resta comunque visitabile su `.pages.dev` prima ancora di avere il dominio pronto.

## Passo 3 — Attivare il gate email per i download (Cloudflare KV, gratuito)

**Correzione (seconda, e ultima si spera):** il deploy è passato tramite "Import a repository" nel nuovo Cloudflare, che crea un **Worker con asset statici**, non un progetto "Pages" classico. Su un Worker, la cartella `functions/` non viene letta affatto, quella era una convenzione esclusiva di Pages. Il file `functions/api/subscribe.js` incluso qui è ormai inutilizzato (puoi anche cancellarlo dal repository, non fa danno se resta).

Al suo posto ci sono due file nuovi da caricare nella radice del repository, esattamente come gli altri:

- `wrangler.jsonc` — dice al Worker dove sono i file statici e quale script gestisce le richieste
- `src/index.js` — un piccolo script che serve i file del sito e gestisce la richiesta di iscrizione email

Caricali su GitHub con lo stesso metodo di sempre (**Add file → Upload files**, trascinando anche la cartella `src`), fai il commit: Cloudflare ripubblica da solo.

Poi collega lo storage per le email:

1. Nel dashboard Cloudflare, vai su **Workers & Pages → KV** e crea un nuovo namespace, ad esempio `gioaviation-subscribers`.
2. Apri il tuo progetto Worker (non più "Pages", ora è elencato come Worker) → **Settings → Bindings** (su un Worker si chiama così, non più "Functions → KV namespace bindings" come su Pages).
3. Aggiungi un binding di tipo **KV Namespace**, con **Variable name** esattamente `SUBSCRIBERS`, collegato al namespace creato al punto 1.
4. Salva. Su un Worker il binding di solito si attiva subito, senza bisogno di un nuovo deploy; se non funziona, fai un commit qualsiasi sul repository per forzare una ripubblicazione.

Da quel momento ogni email inserita per sbloccare un documento viene salvata nel namespace KV, consultabile dal dashboard Cloudflare (Workers & Pages → KV → il tuo namespace → Browse). Ogni voce è nel formato `email::nomefile → {email, doc, data}`.

**Importante:** i tre documenti nella cartella `resources/` sono file placeholder `.txt`, non i PDF veri (vedi sotto), servono solo per verificare che tutto il flusso, dal modulo email al download, funzioni davvero. Puoi già testarlo ora: inserisci una tua email su una qualsiasi card della Home e verifica che il file placeholder venga scaricato e l'indirizzo compaia nel namespace KV.

Quando avrai i PDF reali: rinomina i file in `resources/` (stesso nome, estensione `.pdf`) e aggiorna in `index.html` l'attributo `data-doc` di ogni pulsante con il nuovo nome file.

## Passo 4 — Attivare il modulo contatti (Formspree, gratuito)

Il modulo in `contatti.html` non invia ancora email: manca il tuo endpoint.

1. Crea un account gratuito su [formspree.io](https://formspree.io) (piano free: 50 invii/mese, sufficiente per iniziare).
2. Crea un nuovo form, ti darà un ID tipo `xayzabcd`.
3. Apri `contatti.html`, cerca la riga:
   ```
   action="https://formspree.io/f/REPLACE_WITH_YOUR_FORMSPREE_ID"
   ```
   e sostituisci `REPLACE_WITH_YOUR_FORMSPREE_ID` con il tuo ID reale.
4. Ricarica il sito (ricarica su Cloudflare Pages se già pubblicato) e il modulo funziona.

Finché non lo fai, il modulo mostra un messaggio onesto ("form non ancora configurato") invece di fingere di aver inviato il messaggio.

## Cosa manca prima che il sito sia davvero completo

- **I tre PDF mental map reali** (Idraulico, Elettrico, Comandi di volo): non li ho, esistono in un altro progetto/sessione. Appena me li carichi, sostituisco i placeholder in `resources/` e aggiorno i riferimenti in `index.html` (vedi Passo 3).
- **Il namespace KV** va creato e collegato su Cloudflare perché il gate email funzioni davvero in produzione (Passo 3) — finché non lo fai, il modulo mostra un errore onesto invece di far finta di salvare l'email.
- **Indirizzo email reale** su dominio .aero in `contatti.html` (per ora c'è un placeholder `contact@gioaviation.aero`).
- **Pagine non ancora costruite**: libreria risorse completa e le tre landing dedicate (Equipaggio, Operatori, Candidati) — rimandate volutamente per il lancio minimo, come deciso insieme.

## Nota sulla privacy delle email raccolte

Stai raccogliendo dati personali (email) da utenti reali. Prima di andare online con traffico vero, aggiungi almeno una riga di informativa privacy essenziale vicino al modulo (a cosa serve l'email, che non viene condivisa) — non è ancora presente nelle pagine consegnate qui, ed è un requisito di correttezza verso i tuoi utenti, non solo un dettaglio legale formale.

## Nota su indipendenza

Nessun file qui referenzia Vercel, il team NutriCalc, o altri tuoi progetti. Font caricati da Google Fonts (CDN pubblico, nessun account). L'unica dipendenza esterna per il funzionamento del form è Formspree, ed è a tuo nome, non collegata a nient'altro.
