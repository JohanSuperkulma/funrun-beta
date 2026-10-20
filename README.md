# FunRun beta

Dette er en spillbar nettleserbeta av FunRun. Bruk GitHub Pages-lenken (HTTPS) for GPS-funksjonen.

## Hva betaen gjør

- Lar deg lage en lobby, velge regler og sette opp et spilleområde.
- Viser kartskisse, kontrollsoner, rundevisning og resultater.
- Lar deg prøve flyten i én nettleser med simulerte spillere.
- Kan vise din egen GPS-posisjon på et OpenStreetMap-veikart i live-runden. Trykk «Start GPS» og gi nettleseren tilgang.

## Viktig

- GPS-punktet vises bare på enheten du spiller på. Lobbykoder kobler ikke sammen ulike telefoner, og andre spilleres posisjoner deles ikke.
- Posisjonen lagres ikke i appens tilstand eller sendes til en FunRun-server. OpenStreetMap mottar forespørsler om kartflisene for området kartet viser.
- Området og kontrollsonene er fortsatt en skisse. GPS-grensevarsling og ekte posisjonsdeling mellom spillere er ikke ferdig.
- Nettleseren må ha posisjonstilgang slått på. GPS virker bare på en sikker HTTPS-side.

## Kart

Kartet bruker Leaflet og OpenStreetMap. © OpenStreetMap contributors. Les [OpenStreetMap Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/).

## Publisering med GitHub Pages

Siden publiseres fra `index.html` i rotmappen på grenen `main`.
