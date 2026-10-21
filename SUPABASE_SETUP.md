# Koble til FunRun sitt Supabase-prosjekt

Denne tidlige flerspillerbetaen bruker Supabase for brukerkontoer, lobbyer og posisjonsdeling. Den gamle `index.html`-demoen blir ikke endret av disse stegene.

## 1. Legg inn nettlesernøkkelen

I Supabase åpner du **Project Settings → API Keys**. Kopier prosjektets URL og nøkkelen merket **Publishable** inn i `supabase-config.js`.

Bruk aldri en nøkkel merket **Secret** eller `service_role` i nettsiden. Ikke del databasepassordet.

## 2. Lag tabeller og regler

Åpne **SQL Editor → New query**, lim inn hele `supabase-schema.sql` og trykk **Run**. Scriptet oppretter FunRun-tabellene, tilgangsreglene, live-oppdateringene og RPC-funksjonene. Kjør det én gang på det nye FunRun-prosjektet.

## 3. Tillat e-postbekreftelse tilbake til spillet

I **Authentication → URL Configuration**:

- Sett **Site URL** til `https://johansuperkulma.github.io/funrun-beta`
- Legg til redirect-URL-en `https://johansuperkulma.github.io/funrun-beta/live.html`
- Kontroller at Email provider er aktivert.

Ved brukerregistrering kan Supabase sende en bekreftelseslenke. Spilleren må åpne e-posten før første innlogging hvis e-postbekreftelse er på.

## 4. Åpne flerspillersiden

Når `live.html`, `supabase-live.js` og `supabase-config.js` ligger på GitHub Pages, åpner spillerne:

`https://johansuperkulma.github.io/funrun-beta/live.html`

Alle må lage sin egen konto. Vert lager lobby og deler koden. Posisjon deles bare etter at spilleren trykker **Start GPS**. Databasen begrenser jegerens lesetilgang til aktive kartperioder.

Dette er fortsatt en beta. Tegning av spillegrense og automatisk håndtering når spillere forlater området er ikke koblet til flerspillersiden ennå.
