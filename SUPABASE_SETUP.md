# Koble til FunRun sitt Supabase-prosjekt

FunRun bruker Supabase for kontoer, lobbykoder og flerspillerdata.

## 1. Nettlesernøkkel

I Supabase åpner du Project Settings → API Keys. Bruk prosjektets URL og nøkkelen merket Publishable i supabase-config.js. Ikke bruk Secret eller service_role i nettsiden.

## 2. Databaseoppsett

Siden den eksisterende FunRun-databasen allerede er laget, åpner du Supabase SQL Editor → New query, limer inn hele [supabase-upgrade.sql](https://raw.githubusercontent.com/JohanSuperkulma/funrun-beta/main/supabase-upgrade.sql) og trykker Run én gang. Denne oppgraderingen legger til delte rundeinnstillinger, pakker, kontrollpunkter, sonevarsler, anonym soneoversikt og spillstart. Den begrenser også når jegeren kan lese spillernes posisjoner.

Hvis prosjektet allerede har kjørt `supabase-upgrade.sql`, bruk i stedet [supabase-host-start.sql](https://raw.githubusercontent.com/JohanSuperkulma/funrun-beta/main/supabase-host-start.sql) slik at verten kan starte uten spillerstatus i lobbyen. Kjør den én gang.

For et helt nytt Supabase-prosjekt må du først kjøre supabase-schema.sql og deretter supabase-upgrade.sql.

## 3. Innlogging

E-postinnlogging må være aktivert under Authentication → Sign In / Providers. E-postbekreftelse krever at SMTP er konfigurert.

For telefoninnlogging må Phone provider kobles til en SMS-tjeneste. SMS kan koste penger. Ikke legg SMS-hemmeligheter i nettsiden eller del dem i chatten.

Gjestekontoer kan brukes til å prøve spillet, men de hører til nettleseren på den enheten.

## 4. E-postbekreftelse

Under Authentication → URL Configuration:

- Site URL: https://johansuperkulma.github.io/funrun-beta
- Redirect URL: https://johansuperkulma.github.io/funrun-beta/live.html

## 5. GPS og kart

Åpne https://johansuperkulma.github.io/funrun-beta/ eller https://johansuperkulma.github.io/funrun-beta/live.html. GitHub Pages bruker HTTPS, som kreves for GPS i nettleseren.

Spilleren må trykke Start GPS og tillate posisjonstilgang. GPS deles først når eventuell nedtelling er ferdig. Jegeren kan hente posisjoner i kartperiodene. Når verten velger Omtrent, blir posisjonen avrundet før den sendes til jegeren. «Bare at de er i sonen» viser bare anonyme tall for aktive GPS-posisjoner, ikke spillernavn eller kartpunkter.

Kartet bruker OpenStreetMap-veikart og gratis stedsøk avgrenset til Norge. Det er ikke satellittkart.
