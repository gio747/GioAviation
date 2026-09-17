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
