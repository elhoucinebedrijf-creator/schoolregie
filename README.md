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
**GitHub:** nog niet gepusht

## Status

- [x] Fase 0 - Fundament: schema (31 tabellen, RLS overal), 11 rollen,
      login, rolgebaseerde `dashboard.html` (per rol een gefilterde
      module-lijst), demo-data (1 school, 11 testaccounts, 3 klassen, 20
      leerlingen + ouders, 5 vakken, cursussen).
- [ ] Fase 1 - Gemiste toetsen + AI-inhaaltoets (vlaggenschip-module,
      matcht n8n-workflows 01-02).
- [ ] Fase 2 - Verzuim + maatwerk (workflows 03-05).
- [ ] Fase 3 - Signalen/escalatie + oudergesprekken (workflows 06, 10).
- [ ] Fase 4 - OPP/zorg + zorgoverleg/MDO (workflows 07-08, 13).
- [ ] Fase 5 - Toetsbank + surveillance + rooster/capaciteit (workflows
      09, 11-12).
- [ ] Fase 6 - Management cockpit + import/koppelingen (workflows 14-15).
- [ ] Fase 7 - Alle 15 n8n-workflows activeren + AVG/security-documentatie.

## Rollen

11 rollen uit de spec, vastgelegd in `profiles.role`:
`administrator`, `directie`, `teamleider`, `mentor`, `vakdocent`,
`surveillant`, `verzuimcoordinator`, `zorgcoordinator`,
`kwaliteitsmedewerker`, `ouder`, `leerling`. Iedereen landt op één
rolgevoelige `dashboard.html` (`assets/supabase-client.js` →
`ROLE_HOME`/`ROLE_LABEL`) - geen 11 losse dashboardbestanden, maar een
per-rol gefilterde module-lijst (`ALLE_MODULES` in `dashboard.html`) die
meegroeit naarmate elke fase een module daadwerkelijk bouwt.

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

## n8n-workflows

15 workflows staan al klaar in een "SchoolRegie"-folder in de bestaande
n8n-omgeving (`n8n.elhoucineautomation.nl`), momenteel allemaal inactief
(bevestigd via de n8n API). Ze worden - net als bij KwaliteitsKompas -
per workflow bijgewerkt en pas geactiveerd zodra de bijbehorende edge
function bestaat én rechtstreeks getest is. Zie het plan-bestand voor de
volledige matching tussen workflow en fase/endpoint.

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
