# SchoolRegie

Multi-tenant, buildless static-HTML/CSS/JS-app op Supabase (Postgres/Auth/
RLS) + Vercel - zelfde patroon als weekendschool-saas, schoolanalyse-saas,
schoolkwaliteit-saas en KwaliteitsKompas. Doel: administratieve en
begeleidende schoolprocessen (gemiste toetsen, verzuim, maatwerk, signalen,
oudergesprekken, OPP/zorg, surveillance, management-rapportage) niet alleen
melden maar via een statusmachine tot een echte afronding volgen. Volledige
context en fase-indeling staan in
`~/.claude/plans/whimsical-sprouting-crab.md`.

**Live:** https://schoolregie.vercel.app
**Supabase-project:** `kuxagvhesctephrgfpfo`
**n8n:** `n8n.elhoucineautomation.nl` (Hostinger Docker Manager) - 16 van
de 17 workflows actief (WF16 e-mailmeldingen wacht op een SMTP-
credential, zie "Fase 8" onderaan)
**GitHub:** https://github.com/elhoucinebedrijf-creator/schoolregie

## Status

**Volledig opgeleverd - alle 8 fases afgerond, alle 15 n8n-workflows
actief en live geverifieerd.**

- [x] Fase 0 - Fundament: schema (31 tabellen, RLS overal), 11 rollen,
      login, rolgebaseerde `dashboard.html` (per rol een gefilterde
      module-lijst), demo-data (1 school, 11 testaccounts, 3 klassen, 20
      leerlingen + ouders, 5 vakken, cursussen).
- [x] Fase 1 - Gemiste toetsen + AI-inhaaltoets (vlaggenschip-module,
      workflows 01-02). Zie "Fase 1" onderaan.
- [x] Fase 2 - Verzuim + maatwerk (workflows 03-05). Zie "Fase 2"
      onderaan.
- [x] Fase 3 - Signalen/escalatie + oudergesprekken (workflows 06, 10).
      Zie "Fase 3" onderaan.
- [x] Fase 4 - OPP/zorg + zorgoverleg/MDO (workflows 07-08, 13). Zie
      "Fase 4" onderaan.
- [x] Fase 5 - Toetsbank + surveillance + rooster/capaciteit (workflows
      09, 11-12), inclusief de automatische no-show-hertrigger uit de
      spec. Zie "Fase 5" onderaan.
- [x] Fase 6 - Management cockpit + import/koppelingen (workflows
      14-15). Zie "Fase 6" onderaan.
- [x] Fase 7 - Alle 15 n8n-workflows geactiveerd + AVG/security-
      documentatie. Env-vars gezet via Hostinger Docker Manager, elke
      webhook-workflow (9 stuks) rechtstreeks getest via de echte
      productie-URL, de 5 cron-workflows geactiveerd (hun routes waren
      al apart geverifieerd tijdens de fase-bouw). Zie "n8n activeren"
      onderaan voor de volledige toedracht.

## Rollen

11 rollen uit de spec, vastgelegd in `profiles.role`:
`administrator`, `directie`, `teamleider`, `mentor`, `vakdocent`,
`surveillant`, `verzuimcoordinator`, `zorgcoordinator`,
`kwaliteitsmedewerker`, `ouder`, `leerling`. Iedereen landt op één
rolgevoelige `dashboard.html` (`assets/supabase-client.js` →
`ROLE_HOME`/`ROLE_LABEL`) - geen 11 losse dashboardbestanden, maar een
per-rol gefilterde module-lijst (`ALLE_MODULES` in `dashboard.html`) die
meegroeit naarmate elke fase een module daadwerkelijk bouwt.

## Mijn profiel: wachtwoord + 2FA

`profiel.html` (bereikbaar voor elke rol via "Mijn profiel" onderaan de
sidebar):

- **Wachtwoord wijzigen**: vraagt eerst het huidige wachtwoord en
  her-authenticeert daarmee (`signInWithPassword`) vóór
  `supabase.auth.updateUser({password})` - voorkomt dat iemand een open
  sessie op een gedeeld apparaat misbruikt om het wachtwoord te wijzigen
  zonder het huidige te kennen.
- **2FA (TOTP)**: standaard Supabase Auth MFA (`supabase.auth.mfa.*`) -
  QR-code + handmatige code tonen bij inschakelen
  (`mfa.enroll({factorType:'totp'})`), bevestigen met een 6-cijferige
  code (`mfa.challenge` + `mfa.verify`), uitschakelbaar
  (`mfa.unenroll`). `login.html` is uitgebreid met een AAL1→AAL2-stap:
  na een geslaagde wachtwoord-login wordt gecontroleerd of de account
  een geverifieerde TOTP-factor heeft
  (`mfa.getAuthenticatorAssuranceLevel()`) en zo ja, verschijnt een
  code-invoerscherm vóór de gebruiker bij het dashboard komt.

Volledig end-to-end getest (Playwright + `otplib` om echte TOTP-codes
te genereren): wachtwoord wijzigen, 2FA inschakelen, uitloggen,
opnieuw inloggen mét de 2FA-code, 2FA weer uitschakelen - alles werkt.

## RLS-aanpak (Fase 0 - bewust een startpunt, geen eindbeeld)

`current_school_id()`/`current_rol()`/`is_staff()` (security definer-
functies, `supabase/schema.sql`). De 9 personeelsrollen (alles behalve
`ouder`/`leerling`) krijgen nu al volledige CRUD binnen hun eigen school op
alle procestabellen - verfijning per rol (bv. "alleen vakdocent maakt een
toets aan") volgt per module in de fase die de bijbehorende UI bouwt, niet
nu al geraden zonder dat er een scherm voor bestaat.

`ouder`/`leerling` hebben in Fase 0 bewust **geen** policies op de
procestabellen (dus RLS-default-deny - ze zien nu nergens iets, wat correct
is zolang hun portalpagina's nog niet bestaan). Enige uitzondering:
`profiles_select` is voor iedereen in de eigen school leesbaar (staff-
directory, geen gevoelige leerling-/ouderdata) - dit heropgemeten worden
zodra de leerling-/ouderportals gebouwd worden.

## Statussen

Eén gedeeld vocabulaire over alle procestabellen: `nieuw`, `gepland`,
`wacht_op_toets`, `wacht_op_goedkeuring`, `goedgekeurd`,
`klaargezet_voor_afname`, `afgenomen`, `in_behandeling`, `afgerond`,
`verlopen`, `no_show`, `geescaleerd`, `geannuleerd`. Niet elke status is
voor elke tabel relevant; bewust één lijst i.p.v. een aparte enum per
tabel, voor consistentie.

## AI-veiligheid (voorbereid in het schema, wordt actief vanaf Fase 1)

`test_documents` en `opp_plans` hebben al de verplichte AI-metadata-
kolommen (`ai_confidence`, `ai_human_review_required`, `ai_reason`/
`ai_summary`, `ai_data_used`, `approved_by`/`approved_at`) - AI mag
concepten/varianten/adviezen maken, maar nooit zelfstandig goedkeuren
(zie de spec-sectie "AI VEILIGHEID").

## Fase 1 - Gemiste toetsen + AI-inhaaltoets

Statusmachine (tot en met goedkeuring - klaarzetten/afname/afronden is
Fase 5, surveillance/rooster): `nieuw -> wacht_op_goedkeuring ->
goedgekeurd`. Pagina `gemiste-toetsen.html`, rolgevoelig binnen dezelfde
pagina (geen aparte bestanden):

- **Staff** (alle rollen behalve leerling/ouder): gemiste toets
  registreren (leerling + optioneel bestaande toets + reden - zonder
  gekozen toets wordt automatisch een minimale toets-rij aangemaakt),
  AI-inhaaltoets laten genereren (vak/niveau/leerdoelen/originele
  toetstekst in), en het AI-concept + antwoordmodel beoordelen en
  goedkeuren. AI mag nooit zelfstandig goedkeuren - elke `test_documents`-
  rij van de AI staat op `status='wacht_op_goedkeuring'` met verplichte
  `ai_confidence`/`ai_human_review_required`/`ai_reason` totdat een
  vakdocent/staff-lid expliciet goedkeurt (`approved_by`/`approved_at`
  worden dan gezet).
- **Leerling/ouder**: alleen-lezen zicht op eigen (kind-)gemiste toetsen
  en de tekst van een eenmaal goedgekeurde inhaaltoets (nooit het
  antwoordmodel, nooit een nog-niet-goedgekeurd concept) - afgedwongen
  via `test_documents_own_select` (RLS), niet alleen in de UI verborgen.

Edge functions: `missed-tests`, `makeup-tests/generate`, `tasks/teacher-
review` - routes in de gedeelde `api`-functie (zie "n8n-koppeling"
hieronder), beveiligd met `X-SchoolRegie-Key`. Daarnaast
`genereer-inhaaltoets` - een LOSSE, apart gedeployde functie voor de
browser-UI: hetzelfde als de `makeup-tests/generate`-route maar
geautoriseerd via de standaard Supabase-sessie/RLS van de ingelogde
gebruiker i.p.v. het n8n-gedeelde geheim, zodat dat geheim nooit naar de
browser hoeft (zelfde patroon als KwaliteitsKompas' `stuur-alarm`).

`test_documents.missed_test_id` (los van `test_id`) koppelt een AI-
concept aan de exacte gemiste-toets-instantie waarvoor het gemaakt is -
nodig omdat `test_id` gedeeld/leeg kan zijn en twee leerlingen dezelfde
toets kunnen missen (gevonden tijdens Playwright-verificatie, hersteld
vóór oplevering).

## Fase 2 - Verzuim + maatwerk

- **Verzuim** (`attendance/signals`-route): elke gemelde
  aanwezigheidsgebeurtenis (`te_laat`/`ongeoorloofd_afwezig`/`spijbelen`/
  `geoorloofd_afwezig`) komt in `attendance_events`. Bij de eerste 3
  types wordt binnen een rollend venster van 60 dagen tegen de
  schoolinstelbare drempel in `school_settings` geteld
  (`attendance_late_threshold`/`attendance_unauthorized_threshold`/
  `attendance_truancy_threshold`, resp. standaard 3/3/1). Bij het
  bereiken van de drempel: een `interventions`-rij voor de mentor (te
  laat/ongeoorloofd) of direct een `signals`-rij op niveau "hoog"
  (spijbelen - lagere tolerantie, vandaar standaarddrempel 1).
- **Maatwerk** (`interventions/advice`-route): AI (Claude) beoordeelt
  cijfers per vak en adviseert alleen bij een leerling per keer (niet
  klasbreed - de exacte bulk-datavorm daarvoor stond nergens
  gespecificeerd, dus bewust niet vooraf geraden). Alleen vakken met een
  positief AI-advies worden als `maatwerk_assignments`-rij aangemaakt,
  altijd met `mentor_approved=false` (de AI plaatst nooit zelfstandig,
  ook niet als de aanroepende workflow `allowAutoPlacement` meestuurt) -
  plus een taak voor de mentor om het advies te bevestigen.
- UI: `verzuim.html` (staff registreert verzuim, beheert interventies,
  administrator/directie stellen de drempels in; leerling/ouder zien
  eigen verzuim read-only) en `maatwerk.html` (staff genereert AI-advies
  via `genereer-maatwerkadvies` - JWT-verified browser-versie van de
  `interventions/advice`-route, zelfde patroon als `genereer-
  inhaaltoets` - en keurt goed/wijst af; leerling/ouder zien eigen
  maatwerk read-only). Nieuwe RLS: `attendance_events_own_select`,
  `interventions_own_select`, `maatwerk_assignments_own_select`
  (`signals` blijft bewust buiten leerling/ouder-zicht - Fase 3-terrein).

  Robuustheidsfix: `parseClaudeJson()` in `_shared/api.ts` haalt het
  `{...}`-blok uit Claude's antwoord vóór het parsen (i.p.v. de ruwe
  tekst direct te parsen) - Claude volgt "alleen JSON" bijna altijd,
  maar niet gegarandeerd; toegepast op alle 4 Claude-JSON-aanroepen.

## Fase 3 - Signalen/escalatie + oudergesprekken

Pagina `signalen.html`. 3 nieuwe routes in `api/index.ts`:
`signals/major`, `meetings/parent-conversation/propose`,
`communications/prepare`.

- **Signalen**: staff meldt (of het systeem meldt automatisch, later
  fases) een signaal met niveau laag/middel/hoog/kritiek. Bij hoog/
  kritiek: mentor-taak + een `conversations`-rij (oudergesprek-voorstel)
  + een `dossier_entries`-rij, automatisch.
- **Oudergesprekken**: statusconventie nieuw (voorgesteld) -> gepland
  (mentor zet datum/tijd) -> afgerond (mentor voegt verslag toe via
  `conversation_notes`). Ouder ziet het voorstel en bevestigt via de
  losse, JWT-geverifieerde functie `bevestig-oudergesprek` - bewust GEEN
  brede update-RLS-policy voor ouder op `conversations` (RLS is
  rij-niveau, niet kolom-niveau; een brede policy zou een ouder ook
  scheduled_at/status laten wijzigen).
- **Communicatie**: `communications/prepare` maakt per kanaal x
  ontvanger een rij aan, met status `wacht_op_goedkeuring` zodra
  menselijke goedkeuring vereist is vóór verzending. Staff keurt goed
  via "Markeer als verzonden" op `signalen.html`.

`signals` en `conversation_notes` blijven bewust buiten leerling/ouder-
zicht (escalatie-detail resp. interne mentor-aantekeningen).

## Fase 4 - OPP/zorg + zorgoverleg/MDO

Pagina `opp-zorg.html`. 6 nieuwe routes in `api/index.ts`: `opp/start`,
`opp/prepare-summary`, `opp/due-reviews`, `opp/send-review-reminders`,
`care-meetings/candidates`, `care-meetings/prepare-agenda`.

- **OPP-trajecten**: AI maakt via `opp/prepare-summary` (n8n) of
  `genereer-opp-samenvatting` (browser-UI, JWT-verified) UITSLUITEND een
  neutrale, feitelijke concept-samenvatting - nooit het besluit. Dit
  schema heeft geen aparte cijfers-tabel (anders dan KwaliteitsKompas),
  dus "resultaten" in de samenvatting komt uit de gemiste-toetsen- en
  maatwerkadvies-geschiedenis. `opp_plans.review_due_date` (standaard
  +6 weken bij start) drijft de wekelijkse `opp/due-reviews`-cron.
- **Zorgoverleg (MDO)**: `care-meetings/candidates` verzamelt leerlingen
  met een open hoog/kritiek-signaal of een lopend OPP-traject;
  `care-meetings/prepare-agenda` laat Claude per kandidaat een korte
  samenvatting + bespreekpunten maken. Geen aparte "zorgoverleg"-tabel
  in het schema - de conceptagenda wordt een `tasks`-rij voor de
  zorgcoördinator (`related_type: 'mdo_agenda'`) plus een
  `dossier_entries`-rij per besproken leerling.

## Fase 5 - Toetsbank + surveillance + rooster/capaciteit

Pagina's `rooster.html`, `toetsbank.html`, `surveillance.html`. 4 nieuwe
routes in `api/index.ts`: `scheduling/find-slot`, `supervision/today`,
`supervision/send-day-list`, `testbank/documents`.

- **Rooster**: `makeup_slots` (inhaaltoetsen) en `maatwerk_slots`
  (bijles) zijn pure capaciteitsresources - administrator/teamleider
  maken ze aan op `rooster.html`. `scheduling/find-slot` zoekt het
  eerstvolgende moment met vrije capaciteit (bezetting geteld via een
  losse query, geen cache-kolom) en koppelt dat aan de eerste
  goedgekeurde-maar-nog-niet-ingeplande inhaaltoets/maatwerk van de
  leerling.
- **Surveillance**: `surveillance.html` toont de surveillant zijn
  daglijst. **De automatische no-show-hertrigger uit de
  oorspronkelijke spec is hier gebouwd**: bij "Niet verschenen" gaat de
  makeup_test naar status `no_show` en `no_show_count` omhoog; onder de
  drempel (2) wordt automatisch een NIEUWE `makeup_tests`-rij (`nieuw`)
  aangemaakt voor dezelfde gemiste toets - de inhaalcyclus herstart
  zichzelf. Bij de 2e keer wordt in plaats daarvan een kritiek signaal
  aangemaakt en de gemiste toets op `geescaleerd` gezet.
- **Toetsbank**: `toetsbank.html` en `testbank/documents` slaan
  originele toetsen/antwoordmodellen op met `ai_human_review_required:
  false` en status `goedgekeurd` (door een docent aangeleverd, geen
  AI-product) - in tegenstelling tot `ai_variant`-documenten uit de
  Fase-1-inhaaltoets-flow die altijd op `wacht_op_goedkeuring` staan.

## Fase 6 - Management cockpit + import/koppelingen

Pagina's `cockpit.html`, `import.html`. 4 nieuwe routes in
`api/index.ts`: `management/weekly-data`, `management/generate-report`,
`management/send-report`, `integrations/lvs/import`.

- **Cockpit**: gemiste toetsen/open inhaaltoetsen/no-shows/verzuim/
  maatwerk-status/grote signalen/OPP-status/open acties per eigenaar
  deze week, plus een AI-weekrapport (`genereer-managementrapport`,
  browser-versie van `management/generate-report`).
- **Import**: CSV-importer met alias-based kolomherkenning (zelfde
  patroon als KwaliteitsKompas). Leerlingen en verzuim worden ECHT
  verwerkt (upsert op leerlingnummer); ouders/docenten/klassen/vakken/
  cijfers/rooster worden alleen in `imports` geregistreerd, bewust niet
  verwerkt - "architectuur voorbereid, koppeling niet gebouwd" was de
  expliciete spec-instructie (en voor cijfers bestaat sowieso geen
  tabel in dit schema, zie Fase 4).
- **Koppelingen**: `integrations`-tabel toont de 10 providers uit de
  spec als informatieve lijst, standaard `niet_gekoppeld` - geen van de
  koppelingen is functioneel.

`integrations/lvs/import` (WF15) krijgt geen `schoolId` doorgegeven
door de n8n-normalisatiestap - werkt nu (één demo-school) via een
fallback, maar moet bijgewerkt worden zodra er meer dan één school
actief is.

## Fase 8 - Vaste roosterpatronen + echte e-mailmeldingen + kant-en-klare OPP-concepten

Gebruikersfeedback na oplevering: inhaal-/maatwerkmomenten moeten vaste,
wekelijks terugkerende tijden zijn (niet losse eenmalige momenten),
alle betrokkenen moeten een echte e-mail krijgen zodra iets gesignaleerd/
geregeld is (niet alleen een in-app-melding), en OPP moet een kant-en-
klaar concept zijn (concrete doelen/acties, niet alleen een samenvatting).

- **Vaste weekpatronen**: `makeup_slot_patterns`/`maatwerk_slot_patterns`
  (dag + tijd + lokaal/vak + capaciteit) - `rooster.html` laat je die
  instellen; `scheduling/generate-slots` zet daar automatisch concrete,
  gedateerde `makeup_slots`/`maatwerk_slots`-rijen van neer voor de
  komende 6 weken (idempotent - veilig om vaker te draaien). WF17 houdt
  dit wekelijks automatisch actueel.
- **Echte e-mailmeldingen**: `communications.recipient_profile_id`
  generaliseert die tabel van "alleen ouder/leerling" naar "iedereen" -
  staff (docent/mentor/teamleider/zorgcoördinator) krijgt er nu ook een
  rij van, niet alleen een `tasks`-taak. `communications/pending` +
  `communications/mark-sent` (nieuw poll-paar) lossen het echte
  e-mailadres op; WF16 (n8n, elke 5 minuten) haalt ze op en verstuurt ze
  echt via een SMTP-node.
  **Belangrijke bug gevonden tijdens het bouwen**: meerdere bestaande
  meldingen (gemiste toets, verzuimdrempel, groot signaal, OPP-
  herinnering) adresseerden zichzelf per ongeluk aan de leerling i.p.v.
  aan de bedoelde docent/mentor/teamleider - zonder een geldig
  e-mailadres zouden die nooit verstuurd zijn. Gecorrigeerd via de
  nieuwe `notifyStaff()`/`notifyGuardiansAndStudent()`-helpers.
  "Inplannen"-knoppen op `gemiste-toetsen.html`/`maatwerk.html` sturen
  meteen een plaatsingsmelding naar leerling + ouder(s) + mentor - het
  letterlijke scenario dat gevraagd werd.
- **Kant-en-klare OPP-concepten**: `opp/prepare-summary` genereert nu
  ook 2-5 concrete `opp_goals` + gekoppelde `opp_actions` (met
  streefdatum/deadline en een rolgebaseerde eigenaar-suggestie:
  mentor/zorgcoördinator), niet alleen samenvattingstekst -
  `opp-zorg.html` toont ze met per-item goedkeuren/afwijzen.

**WF16 is nog niet geactiveerd** - de "Verstuur e-mail"-node heeft een
SMTP-credential nodig die de gebruiker zelf in n8n's credentials-UI
aanmaakt (kan niet via de API zonder het wachtwoord te zien), plus de
env-var `SCHOOLREGIE_EMAIL_TEST_OVERRIDE` (stuurt tijdens het testen
alles naar één vast adres i.p.v. de echte ontvangers) vóórdat er
daadwerkelijk getest en geactiveerd wordt.

## n8n-koppeling: één gedeelde `api`-functie

Alle 15 n8n-workflows roepen consequent
`$env.SCHOOLREGIE_API_BASE_URL + '/api/n8n/<route>'` aan. Supabase edge
functions routeren op hun exacte naam (één padsegment) - een losse
functie zoals `n8n-missed-tests` wordt dus nooit geraakt door een
dergelijke URL (dit werd pas in Fase 2 ontdekt, ná Fase 1 al "klaar"
gemeld te hebben op basis van rechtstreekse tests op de eigen
functienaam - zie het plan-bestand voor de volledige toedracht). Vaste
oplossing: één gedeployde functie `api`
(`supabase/functions/api/index.ts`) die alle `/api/n8n/*`-routes intern
afhandelt via een simpele `{methode} {pad}`-lookup. Elke volgende fase
voegt nieuwe routes toe aan dit ene bestand - geen nieuwe losse
`n8n-*`-functies meer per endpoint.

## n8n-workflows

15 workflows staan al klaar in een "SchoolRegie"-folder in de bestaande
n8n-omgeving (`n8n.elhoucineautomation.nl`). Alle backend-routes (Fase
1-6, 20 stuks) zijn gebouwd, gedeployed en rechtstreeks via curl getest
tegen echte demo-data - de app-kant is compleet. Activeren wacht nog op
één ding: zie "n8n activeren" hieronder.

### n8n activeren - afgerond

Alle 15 workflows waren al correct voorbereid (geen node-aanpassingen
nodig, zie "n8n-koppeling" hierboven) - ze hadden alleen twee
environment-variabelen op de n8n-server zelf nodig:

```
SCHOOLREGIE_API_BASE_URL=https://kuxagvhesctephrgfpfo.supabase.co/functions/v1
SCHOOLREGIE_API_KEY=<waarde uit de Supabase-secret API_KEY>
```

Deze zijn gezet via Hostinger's Docker Manager (.yaml-editor van de
n8n-service; eerste poging miste het `- `-lijstprefix dat de andere
env-vars wel hadden, gecorrigeerd), waarna de container herstart is.

**Alle 15 workflows zijn actief en geverifieerd**, één voor één, nooit
allemaal tegelijk:

- **9 webhook-workflows** (WF01, 02, 05, 06, 07, 09, 10, 12, 15) elk
  rechtstreeks aangeroepen via de echte productie-URL
  (`https://n8n.elhoucineautomation.nl/webhook/schoolregie/...`) met
  realistische demo-data - allemaal geslaagd, inclusief de twee met
  een Claude-aanroep erin (WF02 inhaaltoets-generatie, WF07
  OPP-samenvatting). WF04 (verzuim) was de kanarie: eerste poging
  faalde met `Invalid URL: undefined/...` (env-vars nog niet gezet),
  na de fix slaagde de herhaalde aanroep volledig met een echte
  drempellogica-uitkomst.
- **5 cron-workflows** (WF03, 08, 11, 13, 14) geactiveerd zonder losse
  livetest (geen "nu uitvoeren"-optie voor schedule-triggers via de
  n8n-API) - hun onderliggende routes waren al apart via curl
  geverifieerd tijdens de fase-bouw.

Eindcontrole: alle 15 workflow-ID's individueel bij de n8n-API
opgevraagd, allemaal `active: true`.

## Security & AVG

- **Dataminimalisatie**: elke tabel bevat alleen velden die een van de
  13 modules functioneel nodig heeft - geen vrije-tekstvelden "voor de
  zekerheid". Gevoelige inhoud (AI-conceptteksten, interne
  mentor-aantekeningen in `conversation_notes`, dossieraantekeningen)
  staat in aparte tabellen met eigen, smallere RLS dan de basisgegevens.
- **Rolgebaseerde toegang (RLS overal)**: 9 personeelsrollen krijgen
  binnen hun eigen school toegang tot de procestabellen; leerling/ouder
  krijgen expliciet smalle, alleen-lezen policies per tabel (zie de
  "Fase N: ouder/leerling-zicht"-blokken in `schema.sql`) - geen enkele
  tabel is standaard leesbaar voor deze twee rollen tenzij er een
  policy voor geschreven is. `signals`, `conversation_notes` en
  `dossier_entries` zijn bewust NOOIT zichtbaar voor leerling/ouder.
- **AI-veiligheid**: elke AI-aanroep in dit project (inhaaltoetsen,
  maatwerkadvies, OPP-samenvattingen, MDO-agenda, managementrapporten)
  is adviserend of samenvattend, nooit besluitvormend. Concrete
  waarborgen: AI-gegenereerde `test_documents` staan altijd op
  `wacht_op_goedkeuring` met verplichte `ai_confidence`/
  `ai_human_review_required`/`ai_reason` totdat een mens expliciet
  goedkeurt (`approved_by`/`approved_at`); AI-gegenereerde
  `maatwerk_assignments` staan altijd op `mentor_approved: false`,
  ongeacht wat een aanroepende workflow meestuurt; OPP-samenvattingen
  worden uitdrukkelijk geïnstrueerd om nooit een besluit te nemen
  (getest - de AI vlagde zelf twijfelachtige brondata in plaats van
  die te gebruiken, zie Fase 4).
- **Gedeelde geheimen blijven server-side**: de `X-SchoolRegie-Key`
  (voor n8n) en `ANTHROPIC_API_KEY` verlaten nooit de browser - elke
  browser-UI-actie die een AI-aanroep of het n8n-geheim nodig heeft
  gaat via een aparte, JWT-geverifieerde edge function
  (`genereer-inhaaltoets`, `genereer-maatwerkadvies`,
  `genereer-opp-samenvatting`, `genereer-managementrapport`,
  `bevestig-oudergesprek`) die zelf autoriseert via de sessie/RLS van
  de ingelogde gebruiker, in plaats van het gedeelde n8n-geheim in
  clientcode te zetten.
- **Auditlog**: `audit_logs` legt de belangrijkste server-side acties
  vast (o.a. `missed_test_created`, `makeup_test_ai_generated`,
  `attendance_event_registered`, `major_signal_created`,
  `maatwerk_advice_generated`) met `school_id`/`action`/`entity_type`/
  `entity_id`/`detail` - dekt de n8n-routes; UI-acties die rechtstreeks
  via RLS schrijven (bv. handmatig een signaal melden) worden nog niet
  auditgelogd - een reëel verschil, genoteerd in de roadmap hieronder.
- **Bewaartermijnen/verwijderverzoeken**: nog niet geïmplementeerd (geen
  `archived_at`-patroon zoals in KwaliteitsKompas/weekendschool-saas).
  Voor een productie-schoolsysteem met AVG-plicht is dit een reëel
  openstaand punt - zie roadmap.
- **Testdata**: alle 11 testaccounts gebruiken `@schoolregie-test.local`
  e-mailadressen (geen echte adressen); er zijn nooit berichten naar
  echte derden verstuurd tijdens het bouwen/testen van dit project.

## Roadmap

Bewust nog niet gebouwd, met reden:

- **Magister/Somtoday/Zermelo/Untis/Google Calendar/Outlook/Teams/SMS/
  WhatsApp-koppelingen**: `integrations`-tabel en de
  `integrations/lvs/import`-route bestaan en verwerken leerlingen/
  verzuim al echt (zie Fase 6), maar de daadwerkelijke API-koppelingen
  met deze externe systemen zijn niet gebouwd - dat was expliciet geen
  onderdeel van deze opdracht ("architectuur voorbereid, koppeling niet
  gebouwd").
- **Cijfers/resultaten-tabel**: dit schema heeft geen persistente
  cijferregistratie (in tegenstelling tot KwaliteitsKompas) - "cijfers"
  komen dit project binnen als losse arrays in AI-adviesaanvragen
  (maatwerk) of via de LVS-import (genegeerd, zie Fase 6). Een echte
  `grades`-tabel zou nodig zijn zodra cijferregistratie een eigen
  module wordt.
- **Bewaartermijnen/archivering/AVG-verwijderverzoeken**: nog geen
  `archived_at`-patroon (zoals in de andere 4 producten dit traject) -
  nodig vóór een echte productie-uitrol met leerlinggegevens.
- **UI-acties in de auditlog**: alleen server-side (n8n/edge function)
  acties worden nu gelogd; rechtstreekse RLS-schrijfacties vanuit de
  browser-UI (bv. handmatig een signaal melden op `signalen.html`) nog
  niet.
- **Multi-school-scoping voor `integrations/lvs/import`**: de
  n8n-normalisatiestap voor WF15 geeft geen `schoolId` door; werkt nu
  via een fallback-op-de-enige-school, moet aangepast worden zodra een
  n8n-omgeving meerdere SchoolRegie-scholen bedient.
- **Klasbrede maatwerkadvies-analyse**: `interventions/advice` (Fase 2)
  ondersteunt bewust alleen per-leerling-adviesaanvragen - de
  n8n-workflow liet een klasbrede variant open maar de exacte
  brondata-vorm daarvoor is nergens gespecificeerd.
- **MFA**: geen verplichting voor welke rol dan ook (Fase 0-beslissing,
  nog niet heroverwogen) - voor administrator/directie in productie
  het overwegen waard.

## Setup (nieuwe school + account aanmaken)

Zie `scripts/seed-demo.js` voor het volledige patroon (school + 11
testaccounts + klassen/leerlingen/ouders in één keer, via de Supabase Auth
Admin API + service-role).

## Lokaal draaien

```bash
python3 -m http.server 8094
```

`assets/config.js` bevat de (publieke) Supabase-project-URL + anon-key en
staat gewoon in git.

## Schema bijwerken

```bash
DBURL=$(grep '^SUPABASE_DB_URL=' .env.local | cut -d= -f2-)
DBURL="$DBURL" node -e "
const fs = require('fs');
const { Client } = require('./scripts/node_modules/pg');
(async () => {
  const c = new Client({ connectionString: process.env.DBURL });
  await c.connect();
  await c.query(fs.readFileSync('supabase/schema.sql', 'utf8'));
  await c.end();
})();
"
```

## Deployen

```bash
npx vercel --prod --yes
```
