# Aan de slag met SchoolRegie

Deze gids is voor jou als gebruiker van SchoolRegie — niet voor
ontwikkelaars die het zelf hosten/beheren (zie daarvoor `README.md`).

## 1. Inloggen

Log in op `/login.html` met het account dat voor je is aangemaakt (via
**Beheer**, alleen een administrator kan nieuwe accounts aanmaken). Voor
de rollen **administrator** en **directie** is twee-factor-authenticatie
(TOTP) verplicht — bij de eerste keer inloggen word je automatisch naar
de instelpagina gestuurd om een authenticator-app te koppelen. Andere
rollen kunnen dit optioneel instellen onder **Profiel**.

## 2. Je dashboard

Na het inloggen zie je `dashboard.html`: een rolgevoelige module-lijst.
Welke modules je ziet hangt af van je rol — een mentor ziet andere
modules dan een verzuimcoördinator of een ouder.

## 3. De modules

- **Gemiste toetsen** — een gemiste toets melden en een (eventueel
  AI-ondersteunde) inhaaltoets laten genereren, gevolgd tot afronding.
- **Verzuim** — verzuim registreren, met automatische escalatie bij
  herhaling (te laat, ongeoorloofd, spijbelen).
- **Maatwerk** — AI-ondersteund advies voor aangepast (huis)werk, met
  verplichte goedkeuring door een mentor.
- **Signalen** — zorgsignalen en oudergesprekken vastleggen en volgen tot
  bevestiging.
- **OPP & zorg** — ontwikkelingsperspectiefplannen en
  zorgoverleg/MDO-coördinatie, inclusief AI-samenvattingen en digitale
  ondertekening door ouders.
- **Surveillance** — toezicht bij toetsen inplannen en toewijzen.
- **Rooster** — lesrooster en lokaal-/personeelscapaciteit.
- **Toetsbank** — centrale opslag van toetsen en toetsmateriaal.
- **Beheer** — schoolbeheer: leerlingen, klassen, gebruikers/rollen,
  imports, instellingen (waaronder bewaartermijn voor archivering).
- **Cockpit** — managementoverzicht en AI-gegenereerde
  managementrapportage.

## 4. Gegevens importeren

Onder **Beheer → Import** kun je leerlingen, klassen, vakken, ouders en
verzuim in bulk importeren via CSV. Er verschijnt eerst een volledige
preview (met scheidingsteken-detectie en foutmeldingen per rij) vóórdat
er iets wordt opgeslagen.

## 5. Archivering

Onder **Beheer → Instellingen** stel je een bewaartermijn in. Een
leerling/dossier archiveren is altijd een bewuste, handmatige actie per
record (geen automatische verwijdering) — gearchiveerde records
verdwijnen uit de reguliere lijsten maar blijven bewaard.

## Hulp nodig?

Zie `docs/faq.md` voor veelgestelde vragen.
