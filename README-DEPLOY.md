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
- Aggiunto la variabile `RESEND_FROM` = `GioAviation.aero <access@gioaviation.aero>`.

### Cosa devi fare tu (3 cose, tutte in Cloudflare dashboard → Workers & Pages → gioaviation → Settings → Runtime variables and secrets → Add variable, spuntando **Secret**)

Non inserisco io questi valori: sono credenziali, e non è corretto che io le maneggi al posto tuo. Aggiungile tu, sono già pronte da incollare:

1. **`SESSION_SECRET`** (firma i cookie di sessione, non è una password che usi tu — un valore lungo a caso va bene):
   ```
   vIPincouDbH6y6NhARdllEuKRIcZDu5WtWoOGQP5q3Vt91MJJ8zSAGsLH5PkVqiM
   ```
2. **`ADMIN_PASSWORD`** (la password per entrare in `admin.html`; puoi tenere questa o sceglierne una tua):
   ```
   RxwYbCJE56qe6bPR
   ```
3. **`RESEND_API_KEY`** — questa deve venire da te:
   - Crea un account gratuito su [resend.com](https://resend.com) (100 email/giorno gratis, sufficiente per iniziare).
   - Verifica un dominio mittente. **Consiglio:** usa `gioaviation.com` invece di `gioaviation.aero` per ora, perché `.com` è già attivo su Cloudflare mentre `.aero` è ancora in fase di propagazione nameserver — se vuoi, dimmelo e ti aggiorno `RESEND_FROM` di conseguenza e aggiungo io i record DNS che Resend ti chiede (sono record pubblici, non credenziali, posso farlo).
   - Resend ti dà una API key (`re_...`): incollala come secret `RESEND_API_KEY`.

Finché `RESEND_API_KEY` non è configurata, l'approvazione nel pannello admin funziona comunque (l'account viene creato), ma vedrai un errore onesto invece della conferma di invio email — a quel punto dovrai comunicare tu la password al pilota manualmente, recuperandola dal database non è possibile perché è salvata solo cifrata.

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
- La password `RESEND_API_KEY` (vedi sopra) — senza quella l'invio email delle credenziali non parte.
- Le tre landing dedicate (Equipaggio, Operatori, Candidati), rimandate per il lancio minimo.

## Nota sulla privacy dei dati raccolti

Il modulo di richiesta accesso raccoglie nome, email e azienda di persone reali. Prima di andare online con traffico vero, aggiungi una riga di informativa privacy essenziale vicino al modulo (a cosa serve il dato, che non viene condiviso con terzi oltre a Resend per l'invio email) — non è ancora presente, ed è un requisito di correttezza verso i tuoi utenti.

## Nota su indipendenza

Nessun file qui referenzia Vercel, il team NutriCalc, o altri tuoi progetti. Font caricati da Google Fonts (CDN pubblico, nessun account). Le uniche dipendenze esterne sono Formspree (modulo contatti) e Resend (invio credenziali), entrambe a tuo nome.
