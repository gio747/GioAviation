# GioAviation.aero — guida alla pubblicazione

## AGGIORNAMENTO — accesso riservato con approvazione manuale

Il sito è passato da "libreria pubblica con gate email" ad accesso riservato: solo `index.html` resta pubblico, tutto il resto (libreria risorse, credenziali, contatti) richiede login. L'accesso è concesso solo dopo tua approvazione manuale di ogni richiesta.

### Come funziona ora

1. Un pilota compila `richiedi-accesso.html` (nome, email, compagnia, nota) → la richiesta finisce in coda "pending" in un database Cloudflare D1.
2. Tu apri `admin.html` (protetta da una password admin separata, vedi sotto), vedi le richieste in attesa, e clicchi **Approve** o **Reject**.
3. All'approvazione, il sistema genera automaticamente una password, la salva in forma cifrata (mai in chiaro), e manda al pilota un'email con le credenziali tramite Resend.
4. Il pilota fa login su `login.html` e accede a `risorse.html`, `credenziali.html`, `contatti.html`.

Tutto questo gira nel Worker (`src/index.js`), non serve altro codice server.

### Cosa ho già fatto io su Cloudflare (dashboard)

- Creato il database D1 `gioaviation-db` e applicato lo schema (tabella `pilots`).
- Collegato il database al Worker `gioaviation` come binding `DB`.
- Aggiunte le variabili `RESEND_FROM` e `ADMIN_NOTIFY_EMAIL` direttamente in `wrangler.jsonc` (vedi sotto sul perché non vanno più aggiunte solo da dashboard).

### Cosa devi fare tu, in Cloudflare dashboard → Workers & Pages → gioaviation → Settings → Runtime variables and secrets

Non inserisco io questi valori: sono credenziali, e non è corretto che io le maneggi al posto tuo.

1. **`SESSION_SECRET`** (tipo **Secret**) — firma i cookie di sessione: un valore lungo a caso, generato da te o da un password manager.
2. **`ADMIN_PASSWORD`** (tipo **Secret**, non "Variable" — altrimenti resta leggibile in chiaro da chiunque acceda al dashboard) — la password per entrare in `admin.html`.
3. **`RESEND_API_KEY`** (tipo **Secret**) — da [resend.com](https://resend.com) → API Keys. Verifica il dominio mittente: solo `gioaviation.com` è verificato per ora (`gioaviation.aero` no, DNS ancora in propagazione), quindi `RESEND_FROM` nel codice usa `gioaviation.com`.
`ADMIN_NOTIFY_EMAIL` (l'indirizzo a cui arriva una notifica ogni volta che un pilota compila il modulo di richiesta accesso) non è una credenziale ed è già impostata in `wrangler.jsonc` = `admin@gioaviation.com`, insieme a `RESEND_FROM`.

Finché `RESEND_API_KEY` non è configurata, l'approvazione nel pannello admin funziona comunque (l'account viene creato), ma vedrai un errore onesto invece della conferma di invio email — a quel punto dovrai comunicare tu la password al pilota manualmente, recuperandola dal database non è possibile perché è salvata solo cifrata.

**Nota sul deploy automatico da Git — causa reale, non più un mistero:** ogni push su GitHub fa ripartire `wrangler deploy`, che sincronizza le "vars" (non le secret) leggendole SOLO da `wrangler.jsonc`. Qualunque variabile di tipo "Variable" aggiunta a mano da dashboard e non presente in quel file viene cancellata al deploy successivo — è quello che è successo ad `ADMIN_NOTIFY_EMAIL` la prima volta. Le secret (`SESSION_SECRET`, `ADMIN_PASSWORD`, `RESEND_API_KEY`) non sono toccate da questa sincronizzazione e restano quelle inserite da dashboard. Regola pratica: qualsiasi nuova variabile non sensibile va aggiunta in `wrangler.jsonc`, mai solo da dashboard.

### File nuovi/modificati in questo aggiornamento

- `index.html` — ora è la sola pagina pubblica: presenta il sito e rimanda a "Request access" / "Log in", niente più libreria download qui.
- `richiedi-accesso.html` — nuovo modulo di richiesta accesso.
- `login.html` — nuovo login pilota.
- `risorse.html` — nuova libreria risorse (le stesse 3 mental map, ora protette da login invece che dal vecchio gate email).
- `admin-login.html`, `admin.html` — nuovo pannello per approvare/rifiutare le richieste.
- `schema.sql` — schema del database D1 (già applicato da me in produzione, tienilo comunque nel repository).
- `src/index.js` — riscritto: gestisce login, sessioni, approvazioni, invio email; il vecchio endpoint `/api/subscribe` e il gate email sono stati rimossi.
- `wrangler.jsonc` — aggiunto il binding D1.
- Rimossi: `assets/gate.js`, `functions/api/subscribe.js` (sistema precedente, sostituito).

Il modulo contatti (`contatti.html`, Formspree) resta invariato, solo dietro login adesso.

## Come pubblicare questo aggiornamento

Il Worker è collegato al repository GitHub `gio747/GioAviation` (build automatica ad ogni commit). Questo aggiornamento è stato caricato direttamente sul repository sovrascrivendo i file esistenti. Cloudflare ripubblica da solo dopo il commit.

## Cosa manca ancora prima che il sito sia davvero completo

- I tre PDF mental map reali (al momento sono ancora placeholder `.txt` in `resources/`).
- Le tre landing dedicate (Equipaggio, Operatori, Candidati), rimandate per il lancio minimo.

## Nota sulla privacy dei dati raccolti

Il modulo di richiesta accesso raccoglie nome, email e azienda di persone reali. Prima di andare online con traffico vero, aggiungi una riga di informativa privacy essenziale vicino al modulo (a cosa serve il dato, che non viene condiviso con terzi oltre a Resend per l'invio email) — non è ancora presente, ed è un requisito di correttezza verso i tuoi utenti.

## Nota su indipendenza

Nessun file qui referenzia Vercel, il team NutriCalc, o altri tuoi progetti. Font caricati da Google Fonts (CDN pubblico, nessun account). Le uniche dipendenze esterne sono Formspree (modulo contatti) e Resend (invio credenziali), entrambe a tuo nome.

---

## Newsletter (email di notifica per articoli e documenti) — ottobre 2026

### Come funziona

- Quando pubblichi un articolo o un documento trovi la casella **"Also send this article/document as a newsletter"**. Resta spenta finché non scegli **Published**, ed è **sempre non spuntata di default**: l'invio parte solo se la spunti tu.
- Prima di inviare compare una conferma con il numero esatto di destinatari. Un invio non si può richiamare.
- Gli elementi già pubblicati mostrano "Newsletter: sent <data>" oppure "not sent". Se non è partita, c'è il pulsante **Send newsletter**. C'è sempre **Test email**: manda una sola copia a `ADMIN_NOTIFY_EMAIL` e non segna l'elemento come inviato.
- Lo stesso elemento non può essere inviato due volte (campo `newsletter_sent_at`, anche con doppio clic o due schede aperte).
- **Destinatari**: solo piloti approvati, con account attivato (hanno cliccato il link di attivazione, quindi l'indirizzo è verificato) e con consenso esplicito. Nessuno è iscritto d'ufficio: i piloti già presenti partono tutti da "non iscritto".
- Come si iscrive un pilota: casella facoltativa nel modulo di richiesta accesso (vale solo dopo l'approvazione), oppure `newsletter.html` ("Manage notifications" nella home dei membri).
- Come si disiscrive: link in fondo a ogni email (pagina di conferma, un clic), intestazione `List-Unsubscribe` one-click per Gmail/Outlook, oppure `newsletter.html`.
- **Contenuto**: articolo pubblico = titolo, categoria, estratto e link. Articolo solo membri e documenti = solo titolo, categoria (e revisione per i documenti) e link, senza estratto né descrizione.
- **Mittente**: `GioAviation <news@gioaviation.com>`, senza Reply-To. Nel piè di pagina c'è scritto che l'indirizzo non accetta risposte.

### File nuovi o modificati

- Nuovi: `migration-004-newsletter.sql`, `newsletter.html`
- Modificati: `src/index.js`, `wrangler.jsonc`, `.assetsignore`, `admin-articoli.html`, `admin-documenti.html`, `richiedi-accesso.html`, `home-members.html`, `README-DEPLOY.md`

### Procedura di pubblicazione (in quest'ordine)

1. **Database prima del codice.** Cloudflare → D1 → `gioaviation-db` → Console: incolla ed esegui `migration-004-newsletter.sql` **una sola volta**. Il sito attuale continua a funzionare anche dopo la migration (il vecchio Worker seleziona solo colonne esplicite). Se la rilanci per errore ottieni "duplicate column name": ignoralo.
2. **Branch, non `main`.** Su GitHub crea il branch `newsletter` e carica lì i file. Ogni push su `main` va in produzione subito.
3. **Anteprima.** Se Cloudflare mostra un'anteprima per il branch, ricorda che usa lo stesso database e gli stessi secret della produzione: lì usa **solo "Test email"**, mai "Send newsletter".
4. **Merge su `main`** quando l'anteprima va bene. Il deploy parte da solo.
5. **Prova dopo il deploy**: admin → Articles → su un articolo già pubblicato clicca **Test email**. Controlla casella e spam, e che Gmail mostri "Annulla l'iscrizione" accanto al mittente.

### Configurazione

- `RESEND_FROM_NEWS` è già in `wrangler.jsonc` (non va inserita da dashboard, vedi nota sulle "vars" più sopra). Punta a `gioaviation.com` perché è il dominio verificato in Resend. Quando verificherai `gioaviation.aero`, cambia il valore in `GioAviation <news@gioaviation.aero>`.
- Servono già impostati: `RESEND_API_KEY`, `SESSION_SECRET`, `ADMIN_NOTIFY_EMAIL`. Se manca uno dei primi due, la pagina admin lo dice a chiare lettere e non invia nulla.
- Le risposte a `news@` rimbalzano se la casella non esiste. Va bene per un no-reply; se vuoi evitare i rimbalzi, crea un instradamento di posta per `news@` che scarta i messaggi.

### Cose da sapere

- Per vedere un invio reale ti serve un tuo account pilota: l'account admin non ha un profilo iscrivibile. Crea una richiesta con un secondo indirizzo, approvala, attivala e spunta la newsletter.
- Se cambi `SESSION_SECRET`, i link di disiscrizione già spediti smettono di funzionare (il pilota può sempre disiscriversi da `newsletter.html` dopo il login).
- Invio con esito parziale (alcuni batch Resend falliti): l'elemento resta segnato come inviato, per non mandare doppioni a chi l'ha già ricevuto, e la pagina mostra quanti non sono arrivati. Se nessuna email parte, il segno viene tolto e puoi riprovare.
- **Privacy**: l'informativa non esiste ancora e ora copre anche questo trattamento (email di notifica, Resend come fornitore). Scrivila prima di invitare piloti reali a iscriversi.
