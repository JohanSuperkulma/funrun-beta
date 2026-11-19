# FunRun beta

Dette er en nettleserbeta av FunRun. `index.html` er den eksisterende demoen; `live.html` er flerspillerversjonen for kontoer, lobbyer og live-runder. Den bruker et eget Supabase-prosjekt.

## Hva betaen gjør

- Lar deg lage en lobby, velge regler og sette opp et spilleområde.
- Viser kart, kontrollsoner, rundevisning og resultater.
- Lar deg prøve flyten i én nettleser med simulerte spillere.

## Viktig

Den publiserte `index.html`-betaen er en prototype. Lobbykoder kobler ikke sammen ulike telefoner, og posisjoner i selve runden er simulert.

`live.html` bruker Supabase etter oppsett. Se [SUPABASE_SETUP.md](SUPABASE_SETUP.md). Flerspillerbetaen bør prøves med to telefoner før vennene inviteres.

## Publisering med GitHub Pages

1. Opprett et offentlig GitHub-repositorium.
2. Last opp index.html til rotmappen.
3. Gå til Settings → Pages. Velg Deploy from a branch, grenen main og mappen /(root), og trykk Save.
4. GitHub viser nettadressen når siden er publisert.
