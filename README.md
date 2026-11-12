# Evolta Casa

> **Versione sperimentale.** Le simulazioni sono stime orientative, non un progetto tecnico o un preventivo.

Il sito è distribuito da `main` su **https://setola.github.io/evolta-casa/**. Il branch predefinito `develop` contiene il lavoro in corso; solo i push su `main` avviano automaticamente il rilascio pubblico.

## Rilascio su GitHub Pages

Il workflow `.github/workflows/pages.yml` esegue `npm ci`, test e build in un container con la stessa immagine Node di Compose, poi pubblica **solo `dist/`** con le azioni ufficiali Pages. Non occorrono branch `gh-pages`, token personali o backend.

1. Su GitHub aprire **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Per Google Maps/Places, aggiungere le variabili repository in **Settings → Secrets and variables → Actions → Variables**: `VITE_GOOGLE_MAPS_API_KEY` e, se necessarie, `VITE_GOOGLE_MAPS_PLACES_API_KEY` / `VITE_GOOGLE_MAPS_JS_API_KEY`. Sono chiavi browser pubbliche: limitarne API e referrer HTTPS in Google Cloud (per esempio `https://setola.github.io/*`). Senza chiavi il sito parte, ma Maps/Places non sono disponibili.
3. Portare le modifiche su `main`: ogni push esegue test e deploy. Per una prima anteprima da `develop`, usare **Actions → Deploy GitHub Pages → Run workflow**, selezionando `develop`; il workflow deve essere presente sul branch predefinito. Se l'environment `github-pages` limita i branch, autorizzare anche quello selezionato.
4. Controllare l'esito dei job e aprire l'URL restituito dal deploy: normalmente **https://setola.github.io/evolta-casa/**.

Il percorso base e l'origine della sitemap sono ricavati dalla configurazione Pages, anche per un dominio personalizzato. Navigazione, asset, configurazione e PWA rispettano il sottopercorso; le route note e le pagine SEO hanno un proprio `index.html`, quindi sono accessibili direttamente e dopo reload. Gli URL sconosciuti restituiscono il 404 di Pages. Le pagine SEO restano governate dallo YAML pubblico.

Verificare dopo il rilascio home, `/evolta-casa/consumi/`, `/evolta-casa/prezzi/`, il vecchio `/evolta-casa/pannelli/`, navigazione avanti/indietro e installazione PWA. Esportare i progetti prima di cambiare origine: lo storage locale non viene trasferito dal sito LAN a GitHub Pages.

Per riprodurre la build Pages localmente, a servizi fermi e dopo la preparazione Docker:

```sh
docker compose run --rm -e BASE_PATH=/evolta-casa/ -e SITE_URL=https://setola.github.io/evolta-casa npm run build
docker compose run --rm --publish 4173:4173 -e BASE_PATH=/evolta-casa/ npm run preview -- --port 4173 --strictPort
```

Aprire `http://<DEV_HOST>:4173/evolta-casa/`. Senza queste variabili la build resta utilizzabile alla radice `/`. Le chiavi pubbliche vanno fornite durante la build, non al server di preview.

## Ambiente Docker-only

Prerequisiti sull'host: Docker con Compose v2 e una shell con utility standard. Non occorrono Node, npm o browser per test automatici sull'host. Un browser locale serve per l'uso manuale.

Toolchain: React, TypeScript, Vite e Vitest. Tutti i comandi girano in `/app`, corrispondente alla radice del repository. `src/` contiene applicazione e test dei motori; `public/` contiene asset, service worker e configurazione; `scripts/generate-sitemap.mjs` completa la build in `dist/`.

Si usa l'immagine ufficiale `node:26.13.0-bookworm-slim`, fissata tramite digest in `compose.yaml`: Node 26.13.0 è la LTS Lithium, verificata nell'[indice ufficiale delle release](https://nodejs.org/dist/index.json). Il requisito `engines.node ^26.13.0` del manifest è allineato alla linea LTS scelta e soddisfa la toolchain risolta. Le dipendenze dichiarano intervalli di versione espliciti nel manifest e sono risolte in `package-lock.json`: l'installazione riproducibile usa **`npm ci`**, senza aggiornare il lockfile. Nessuna immagine personalizzata è necessaria.

### Preparazione iniziale

Dalla radice, su host POSIX/Linux:

```sh
cp .env.example .env
export LOCAL_UID="$(id -u)"
export LOCAL_GID="$(id -g)"
mkdir -p .docker/node_modules
docker compose run --rm npm ci
```

Ripetere gli export in ogni nuova shell, oppure riportare i valori ottenuti con `id -u` e `id -g` nei campi di `.env`. Non assumere che tutti gli utenti abbiano UID/GID 1000. I container non sono privilegiati e scrivono con queste identità; anche `dist/` rimane utilizzabile dall'host. Su macOS/Windows usare Docker Desktop e una shell POSIX (per esempio WSL2), con la condivisione della directory abilitata.

La directory delle dipendenze deve essere creata dall'utente **prima** di Docker; il mount rifiuta un percorso mancante. Non sono richiesti submodule, download di asset preliminari o login CLI. Per scaricare immagini e pacchetti servono accesso al registry Docker e al registry npm.

### Avvio e arresto

```sh
docker compose up -d
docker compose logs -f web
docker compose down
```

Il solo servizio predefinito è `web`: installa le dipendenze con `npm ci`, poi avvia Vite su `0.0.0.0:5173` nel container. Attendere nei log che Vite sia pronto; l'avvio detached non è una verifica di readiness. Un healthcheck HTTP segnala la readiness e viene usato dal proxy HTTPS opzionale. La CLI `npm` ha profilo opzionale `cli` e non parte con `up`.

Il workflow predefinito è una VM che serve un browser su un altro PC della LAN, **senza tunnel SSH**. La porta è pubblicata su **tutte le interfacce host**, non solo loopback. Impostare in `.env` `DEV_HOST` al nome risolvibile della VM (default `evolta-casa.local`, da configurare nel DNS LAN o nel file hosts dei client), oppure al suo IPv4 LAN. Per esempio, se la VM è `192.168.82.124`, aprire **http://192.168.82.124:5173** dal PC. L'URL canonico è `http://<DEV_HOST>:<APP_PORT>`; `DEV_HOST` non include schema o porta. Sulla VM è ancora disponibile http://localhost:5173.

Vite ammette automaticamente IP e localhost; gli hostname fidati sono `DEV_HOST` e quelli elencati in `DEV_ALLOWED_HOSTS` (separati da virgole, senza schema/porta). Non disabilitare globalmente la validazione host. Per usare più nomi della stessa VM, aggiungerli esplicitamente; per cambiare porta impostare `APP_PORT=5180` e ricreare con `docker compose up -d`, poi aprire `http://<DEV_HOST>:5180`. La porta interna resta 5173, `--strictPort` evita cambi silenziosi e HMR usa l'origine effettiva del browser, inclusi porta pubblicata e protocollo HTTPS quando presente. Non serve una porta HMR separata. Non usare `web`, `0.0.0.0` o il localhost del PC remoto come indirizzo della VM. I sorgenti sono bind-mounted: le modifiche sono immediatamente visibili a Vite.

Gli IP/nomi alternativi sono raggiungibili, ma costituiscono **origini browser distinte**: mantenere lo stesso URL canonico per ritrovare progetti e bozze. IPv6 non è richiesto dal workflow attuale: se necessario, verificare pubblicazione Docker dual-stack, routing e accesso reale dal client; usare URL con IP tra parentesi quadre. Il solo mapping Compose non garantisce IPv6.

**Sicurezza LAN:** prima dell'avvio consentire TCP `APP_PORT` (e `TLS_PORT` solo se usata) dai soli client/subnet fidati e negare gli altri ingressi, su ogni interfaccia pubblicata, IPv6 incluso se attivo. Usare controlli effettivi per le porte Docker: per esempio regole `DOCKER-USER` con backend iptables, regole equivalenti nel backend nftables, oppure ACL/firewall della VM/hypervisor a monte. UFW/il normale firewall host potrebbero essere aggirati dal NAT Docker; verificarlo da una rete non autorizzata. Non modificare alla cieca le regole Docker, non esporre il server su Internet e non configurare port forwarding sul router. Queste regole sono specifiche dell'infrastruttura e non vengono alterate da Compose.

### Comandi indipendenti: build, verifica e CLI

**Serializzazione obbligatoria:** `web` e `npm` condividono dipendenze, cache Vite e output. Arrestare `web` prima di installazioni/build/test/preview; eseguire un comando alla volta. Non avviare `web` durante un altro comando. Un nome progetto Compose diverso non isola questi percorsi; per concorrenza usare checkout separati con proprie directory `.docker/`.

Dopo la preparazione iniziale, anche ad applicazione ferma:

```sh
docker compose stop web
docker compose run --rm npm ci
docker compose run --rm npm test
docker compose run --rm npm run build
```

- `npm test`: `vitest run`, test dei motori senza server né browser automatico.
- `npm run build`: `tsc` (verifica tipi senza emissione), `vite build`, generazione sitemap/pagine con Node. Output in `dist/` sull'host.
- Non esiste un task lint: non viene introdotto artificialmente.
- Verifica dei soli tipi: `docker compose run --rm npm exec tsc -- --noEmit`.
- CLI generica: `docker compose run --rm npm --help`. Per aggiornamenti intenzionali alle dipendenze usare la stessa CLI e revisionare manifest/lockfile.

Il servizio `npm` seleziona l'eseguibile tramite entrypoint; tutto ciò che segue il nome del servizio sono argomenti di npm. Il targeting abilita automaticamente il profilo; la forma esplicita equivalente è `docker compose --profile cli run --rm npm test`. `--rm` elimina il container, non i file montati. Gli errori restituiscono un exit code nonzero. `exec` richiede invece un servizio già avviato e non è necessario per queste operazioni.

Preview manuale della build (non è un server di produzione):

```sh
docker compose run --rm --publish 4173:4173 npm run preview -- --port 4173 --strictPort
```

Aprire `http://<DEV_HOST>:4173` dal PC LAN (oppure http://localhost:4173 sulla VM); Ctrl-C termina la preview. Anche questa porta è su tutte le interfacce: autorizzare TCP 4173 solo dalla LAN fidata. `compose run` non pubblica porte automaticamente. Per una porta diversa cambiare solo il lato host di `--publish`, per esempio `4180:4173`, e aprire quel nuovo URL. La preview usa la stessa allowlist di hostname del server di sviluppo.

## Configurazione e servizi esterni

`.env` (ignorato da Git) serve per l'interpolazione Compose:

| Variabile | Uso | Default |
| --- | --- | --- |
| `LOCAL_UID`, `LOCAL_GID` | Identità dei servizi, obbligatoria | Nessuno |
| `APP_PORT` | Porta host di `web`, tutte le interfacce | `5173` |
| `DEV_HOST` | Nome/IP canonico della VM; allowlist Vite e certificato Caddy | `evolta-casa.local` |
| `DEV_ALLOWED_HOSTS` | Altri hostname LAN fidati, separati da virgole | Vuoto |
| `TLS_PORT` | Porta host del proxy opzionale, tutte le interfacce | `8443` |

Compose **non inietta automaticamente** `.env` nei container. Node riceve esplicitamente `HOME=/tmp`, `NPM_CONFIG_CACHE=/tmp/npm-cache`, `DEV_HOST`, `DEV_ALLOWED_HOSTS` e le tre variabili pubbliche Google Maps elencate sotto, se definite sull'host o in `.env`; Caddy riceve soltanto i propri percorsi scrivibili e `DEV_HOST`, non le chiavi frontend. Dopo cambi di queste variabili ricreare i servizi con `up -d`. Vite carica separatamente i file dotenv dalla radice montata: non usare prefissi `VITE_` in `.env` per segreti.

La configurazione applicativa pubblica è `public/config/assumptions.yaml`, letta dal browser da `/config/assumptions.yaml`. Non ci sono credenziali obbligatorie per avviare ambiente, build o test. Google Maps/Places richiedono una chiave opzionale; senza chiave quelle funzionalità non sono disponibili. Per abilitarle, esportare la chiave nella **stessa shell che esegue Compose**:

```sh
export VITE_GOOGLE_MAPS_API_KEY=replace-with-public-browser-key
docker compose up -d --force-recreate web
```

Compose inoltra esplicitamente la variabile ai servizi `web` e `npm` (anche per `npm run build`), non a Caddy. In alternativa definirla nel file ignorato `.env` oppure lasciare che Vite la legga dal file ignorato **`.env.local`**:

```dotenv
VITE_GOOGLE_MAPS_API_KEY=replace-with-public-browser-key
```

Le variabili già presenti nell'environment del container hanno precedenza sui file dotenv di Vite. Le voci Compose senza valore restano non impostate se assenti, preservando il fallback `.env.local`; non esportare una stringa vuota se si vuole usare quel fallback. Un semplice `restart` non aggiorna l'environment del container: ricrearlo dopo cambi dell'env host.

Varianti supportate: `VITE_GOOGLE_MAPS_PLACES_API_KEY` ha precedenza per Places; `VITE_GOOGLE_MAPS_JS_API_KEY` è il fallback per Maps dopo `VITE_GOOGLE_MAPS_API_KEY`. Ulteriore fallback comune: `map.googleMapsApiKey` nello YAML pubblico. Non committare chiavi reali. Tutti questi valori sono **pubblici**, visibili nel browser; applicare restrizioni Google per API e HTTP referrer coerenti con origine e porta effettive (anche preview). Non inserire token segreti nei file frontend o nell'immagine. I test non richiedono chiavi: usare configurazione di sviluppo, mai credenziali di produzione.

Vite legge `.env.local` durante sviluppo e build grazie al bind mount, non grazie all'environment Compose. Riavviare `web` dopo variazioni dotenv; per la preview ricostruire il bundle: le variabili `VITE_*` sono incorporate in build e non si cambiano passando environment al server statico.

Il browser usa Internet per Google Maps/Places, Nominatim/OpenStreetMap (ricerca indirizzi) e Google Fonts. Non c'è backend locale o database da ricreare in Compose, né OAuth configurato. PVGIS è citato come fonte nella configurazione, ma non è un'API chiamata attualmente dall'applicazione.

## Tetto e disposizione automatica

Il percorso è **Trova casa → Tetto → Consumi → Casa futura → Mobilità → Risultati**: non c’è più uno step Pannelli separato. Nello step Tetto si disegnano i perimetri e si assegna il **Nome della falda** (precompilato “Falda N”, massimo 80 caratteri; un nome vuoto blocca il salvataggio). I nomi restano modificabili nell’elenco, senza alterare geometria o disposizione. Ogni falda riceve un colore distinto, condiviso tra contorno/vertici sulla mappa e bordo/sfondo sfumato delle righe in modifica e preview. Il campo opzionale `RoofPlane.color` viene salvato nel progetto: rinomina, eliminazione di altre falde e ricarica non cambiano il colore; i vecchi progetti ricevono automaticamente colori univoci. La CTA testuale **Disegna la prima falda** appare solo a elenco vuoto; dopo il primo disegno si usa il pulsante **+** accanto al titolo per aggiungerne altre e il **−** su ciascuna riga per eliminarla. Le icone hanno tooltip ed etichette accessibili; eliminando l’ultima falda ricompare la CTA iniziale. Gli ostacoli seguono lo stesso schema per la falda selezionata: CTA testuale per il primo, poi **+** accanto alla scelta del tipo e **−** su ogni ostacolo salvato; eliminando l’ultimo ricompare la CTA testuale. **Inclinazione del tetto**, **Ostacoli sul tetto** e **Suddivisioni interne** sono accordion facoltativi inizialmente chiusi. Chiudere un editor o cambiare la falda scarta solo la relativa bozza; i dati salvati rimangono nel progetto.

**Vedi i pannelli** apre la preview sulla stessa mappa: per ogni falda il sistema confronta una griglia portrait e una landscape e sceglie quella con più moduli (parità → portrait). Mostra numero di pannelli e kWp come **capacità massima stimata**, non come taglia economicamente consigliata: quella viene scelta dalla simulazione sui consumi. Non si aggiungono/rimuovono singoli pannelli e non si sceglie manualmente l’orientamento. **Modifica superfici** torna ai perimetri e agli ostacoli; **Continua ai consumi** conferma le superfici e passa direttamente a `/consumi`. Se la capacità è zero, occorre correggere le superfici prima di continuare. I layout dei progetti precedenti vengono ricalcolati all’apertura dell’editor e prima di una nuova simulazione; nomi, perimetri, ostacoli, `slopeLines` e zoom sono preservati.

### Geometria della stima

Le dimensioni fisiche del modulo restano quelle configurate (1,13 × 1,76 m, 450 W). `packPanels` opera nello spazio fisico della falda: margini e spaziatura si applicano alla griglia in quello spazio; centri e footprint vengono riproiettati in pianta con `cos(pitchDeg)`. Il renderer usa lo stesso helper `panelFootprint`, evitando differenze tra conteggio e immagine. `areaM2` rimane l’area in pianta, non la superficie inclinata. Assunzione MVP: colmo lungo la prima `slopeLine`, altrimenti lungo il lato più lungo; pendenza lungo l’asse perpendicolare. È un confronto fra due griglie omogenee, non un ottimo globale o un rilievo 3D; nessuna garanzia progettuale su ombre o distanze normative specifiche. I moduli devono essere interamente dentro la falda, anche in presenza di rientranze, e non sovrapporsi agli ostacoli.

### Zoom e compatibilità

Lo zoom è una riga discreta nel fondo della card delle falde, separata da “Suddivisioni interne” da una sola linea e disponibile sia in modifica sia in preview: non c’è più un pannello zoom flottante sulla mappa. L’editor apre la vista a **2×**, oppure allo zoom salvato. La scelta **1× / 2× / 4×** rimane invariata passando dalla modifica alla preview e tornando dai consumi; `roof.mapMagnification` è inclusa in bozza ed esportazione (default 2× nei vecchi progetti). Lo zoom non aggiunge dettaglio fotografico né modifica geometrie. Logo, attribuzioni e controlli nativi Google mantengono la dimensione originale senza essere copiati, nascosti o privati dei link; sui viewport piccoli la loro visibilità resta gestita da Google. Trascinare lo sfondo sposta la vista; **Ricentra** torna alla posizione confermata. In modifica i punti di falde e ostacoli restano selezionabili, trascinabili ed eliminabili a ogni zoom anche con gli accordion chiusi; la preview non permette di manipolare i moduli. Non vengono salvate copie delle immagini Google.

Il vecchio URL `/pannelli` (anche con slash finale) viene normalizzato a `/tetto`, conservando query e hash, sia al caricamento sia tramite cronologia browser. La build continua a generare la relativa pagina statica per evitare 404 sui vecchi bookmark, ma lo step non compare nel wizard.

### Verifica manuale

Con Google Maps configurato: disegnare/nominare falde, ostacoli e separazioni; inserire, spostare ed eliminare punti a 1×/2×/4×; aprire la preview e controllare i footprint proiettati, tornare alla modifica, poi continuare direttamente ai consumi. Verificare persistenza dopo reload/ritorno al tetto e apertura del vecchio `/pannelli`. Ripetere su schermo stretto con input touch. I test automatici coprono geometria, scelta del layout, preview, routing e gesti simulati; il rendering live richiede comunque la verifica browser. `RoofMapViewport` compensa anche lo scarto fra centro della proiezione Maps e centro del canvas non scalato.

## Stima guidata dei consumi

La pagina `/consumi` propone prima un percorso in tre passaggi: persone/superficie/presenza, dotazioni attuali, riepilogo. **Ho già i consumi** apre subito l’inserimento manuale senza modificare il progetto. Le risposte restano una bozza locale al componente fino a **Usa questa stima**; la conferma salva un consumo annuo e le risposte nel progetto, elimina eventuali serie elettriche precedenti e invalida i risultati. La conferma porta direttamente a Casa futura, senza mostrare il modulo manuale. Wizard e inserimento manuale sono percorsi alternativi: il modulo si apre esclusivamente dal link **Ho già i consumi**, anche tornando sulla pagina dopo una stima salvata. Cambiare il consumo o la modalità rimuove l’indicazione di stima domestica. Le dotazioni future e l’auto non sono incluse.

Il modello orientativo è in `src/engines/householdEstimate.ts`: base di 1.000 kWh/anno più 350 per persona (frigorifero, lavatrice, luci e piccoli apparecchi inclusi); lavastoviglie 100 + 50 per persona, asciugatrice 100 per persona, raffrescamento 5 per m², acqua calda elettrica tradizionale 520 per persona, induzione 150 per persona. Riscaldamento: pompa di calore 30 per m², resistenze 90 per m². Totale arrotondato a 50 kWh. Sono coefficienti semplificati, non dati misurati né una replica del modello Segugio: non considerano clima, classe energetica o frequenze individuali. La presenza distribuisce i consumi nelle ore, senza cambiare il totale. Il gas non viene stimato e va verificato in bolletta. I risultati segnalano esplicitamente quando il consumo elettrico deriva da questo modello.

Test dedicati: `src/engines/householdEstimate.test.ts` e `src/ui/ConsumptionStep.test.tsx`. Verifica manuale consigliata su desktop e telefono: completare il wizard, tornare tra passaggi, saltarlo, confermare e correggere il valore, ricaricare il progetto, verificare la navigazione verso Casa futura.

## Prezzi e assunzioni per esperti

`/prezzi` è accessibile dal link discreto nel footer, non più dal menu numerato. Da Mobilità si passa direttamente ai risultati; tornare indietro dai risultati riapre Mobilità. La pagina contiene tabelle contestuali con valore, unità e uso: tariffe/costi manuali, investimento, modulo e tetto, produzione solare, batteria, profili domestici, elettrificazione, ricarica e ottimizzazione. Riporta inoltre dati effettivi del progetto e costanti fisse del motore in sola lettura, compresi limiti e configurazioni attualmente non utilizzate.

L’avviso invita a modificare i valori solo se esperti. **Applica modifiche** valida atomicamente numeri, quote, lunghezze e somme dei vettori (liste JSON), salva tariffe e override tecnici nel progetto e invalida i risultati. **Calcola scenari** applica la configurazione effettiva anche al nuovo layout FV. Il prezzo mobilità mostrato è quello realmente usato da `currentVehicle.price`, non il solo prezzo di riferimento iniziale. Il riepilogo Casa futura usa gli stessi coefficienti dei motori.

`Project.assumptionOverrides` conserva solo differenze rispetto al modello base: sono incluse nella bozza, nel salvataggio locale e nell’export/import JSON. Non modificano lo YAML né altri progetti. Il risolutore in `src/assumptions.ts` accetta solo i percorsi censiti e valori validi; i vecchi progetti senza override continuano a usare lo YAML. **Ripristina parametri tecnici predefiniti** prepara il ripristino, da confermare con Applica; tariffe e costi manuali rimangono invariati. Le costanti del wizard restano indipendenti dagli override di elettrificazione futura.

Test: `src/assumptions.test.ts` e `src/ui/TariffsPage.test.tsx` coprono validazione, isolamento, export/import, applicazione al motore, modifica/ripristino e navigazione. Verifica manuale consigliata su desktop e telefono: link nel footer, scorrimento tabelle, modifica/applicazione/ricalcolo, ricarica della bozza e ritorno a Mobilità dai risultati.

## File generati, cache e dati

- `.docker/node_modules/`: dipendenze Linux del container, isolate da un eventuale `node_modules/` host; include cache rigenerabili degli strumenti. Ignorata da Git. Non riutilizzarla con immagini Alpine/musl o runtime/architetture incompatibili; a servizi fermi cancellarla, ricrearla e ripetere `npm ci` dopo tali cambi.
- `/tmp` nei container: home/cache npm scrivibili ed effimere; eliminate con il container. Nessun login o catalogo persistente richiesto.
- `dist/`: output rigenerabile e ignorato, cancellabile a servizi fermi e ricostruibile con `npm run build` nel container.
- `.docker/caddy-data/`: CA locale e chiavi/certificati del proxy opzionale, persistono ai restart. Directory privata, ignorata; non condividere la chiave CA con i client, distribuire solo `caddy/pki/authorities/local/root.crt`. Fare backup sicuro della directory a proxy fermo se si vuole preservare la fiducia installata sui dispositivi; ripristinarla prima di avviare Caddy con lo stesso UID/GID. Cancellandola si rigenera la CA e occorre rimuovere la vecchia fiducia e installare il nuovo certificato sui client.
- `.docker/caddy-config/`: configurazione Caddy rigenerabile. Nessun volume Docker contiene progetti utente. `docker compose down` non cancella i bind mount.
- I progetti utente sono in **IndexedDB** (`evolta-casa`) e le bozze in **localStorage**, per origine browser (schema, hostname, porta). Sopravvivono ai restart ma non sono salvati da Docker. Prima di cancellare storage o cambiare origine, esportare i progetti in JSON dall'app e conservarli; usare l'import JSON per ripristinarli. Cancellare i dati browser elimina anche le bozze locali.

## PWA e verifica manuale

La build di produzione registra `sw.js` e usa un manifest relativi al percorso base; il server di sviluppo non registra nuovi worker. L'offline è parziale, non include i servizi esterni né garantisce il primo avvio senza rete. Su **localhost HTTP** il browser consente service worker e altre funzioni secure-context. Verificare il comportamento production-like con la build e la preview sopra, all'origine `http://localhost:4173`, distinta da quella di sviluppo. Non sono configurati test browser automatici.

Per evitare asset obsoleti in sviluppo: DevTools → Application → Service Workers → Unregister e Cache Storage → eliminare le cache `evolta-casa-*`, poi ricaricare. Il restart dei container non resetta il browser. Prima di usare “Clear site data” esportare i progetti: quella funzione elimina anche IndexedDB/localStorage.

### HTTPS da PC remoto o telefono

HTTP LAN consente l'interfaccia normale, ma **non** service worker, installazione PWA o geolocalizzazione che richiedono un secure context. Non basta sostituire localhost con l'IP della VM. Per queste verifiche usare il profilo opzionale `tls`, con immagine ufficiale Caddy 2.10.2 Alpine fissata per digest; non condivide dipendenze native con Node.

1. Configurare `DEV_HOST` in `.env` con il nome/IP raggiungibile dal dispositivo. L'hostname deve risolversi alla VM tramite DNS LAN o file hosts; per un telefono senza DNS dedicato si può usare l'IPv4 della VM come `DEV_HOST`.
2. Preparare i percorsi **come utente host**, poi avviare il proxy (attende il healthcheck di `web`):

   ```sh
   mkdir -p .docker/caddy-data .docker/caddy-config
   chmod 700 .docker/caddy-data .docker/caddy-config
   docker compose --profile tls up -d
   docker compose logs -f https
   ```

3. Caddy genera la CA e il certificato **nel container**, senza tool TLS host. Copiare dal filesystem della VM il solo certificato pubblico `.docker/caddy-data/caddy/pki/authorities/local/root.crt` sul PC/telefono tramite un canale fidato, verificandone la provenienza. Importarlo nelle autorità radice fidate del sistema/browser: in Firefox usare Impostazioni → Privacy e sicurezza → Certificati → Autorità; su iOS installare il profilo e abilitare la fiducia completa; su Android installare come certificato CA nelle impostazioni di sicurezza. I nomi dei menu variano. Non trasferire `root.key` né limitarsi a ignorare l'avviso TLS: il certificato deve risultare fidato. Rimuovere la CA dai dispositivi quando non serve più.
4. Aprire **`https://<DEV_HOST>:8443`**, oppure la `TLS_PORT` scelta. TLS e HMR/WSS passano sulla stessa porta; il proxy non pubblica porte admin né redirect HTTP. Il certificato è valido per il solo `DEV_HOST`; per verificare un nome/IP diverso cambiare `DEV_HOST` e ricreare `web`/`https`. L'accesso HTTP diretto agli altri indirizzi resta disponibile.

Controllare nel browser che `window.isSecureContext` sia `true`, non ci siano errori console e una modifica al sorgente aggiorni la pagina con WebSocket connesso (WSS per TLS). Cambiando `APP_PORT` o `TLS_PORT`, ripetere questi controlli all'URL effettivo. PWA e geolocalizzazione dipendono anche dal supporto/permessi del browser. Per verificare registrazione del service worker e PWA usare la build con preview localhost descritta sopra oppure il sito HTTPS su Pages: il proxy TLS punta al server di sviluppo, che non registra nuovi service worker, e non è un deployment di produzione.

`docker compose stop https` disattiva il proxy; `docker compose --profile tls down` rimuove entrambi i servizi mantenendo i dati CA. Un successivo `up -d` senza profilo non ferma un proxy già attivo: i profili non sono ambienti mutuamente esclusivi.

## CI e requisiti non applicabili

La pipeline di rilascio Pages esegue installazione riproducibile, test e build nel container Node prima del deploy. Non installa Node sul runner host e non usa i mount di sviluppo. In locale restano validi i comandi Compose descritti sopra.

**Verifica sicurezza prima del rilascio pubblico:** dopo l'aggiornamento delle dipendenze, `npm audit` non segnala vulnerabilità note e `npm outdated` non segnala pacchetti superati. Ripetere `docker compose run --rm npm audit` prima di ogni rilascio: nuove segnalazioni possono emergere nel tempo. Il deploy non costituisce una certificazione di sicurezza.

Non applicabili all'attuale progetto: submodule, toolchain extra (Hugo, ImageMagick ecc.), servizi dati locali, login CLI, migrazioni, cataloghi incrementali, OAuth, task lint e server/runner per test browser. I test unitari non avviano servizi dipendenti: non necessitano di un profilo test o di teardown di server e non arrestano l'app dello sviluppatore. La serializzazione manuale sopra resta necessaria per i mount condivisi.
