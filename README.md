# FunRun

FunRun kan installeres fra nettleseren på mobilen via «Legg til på Hjem-skjerm» eller «Installer app».

FunRun is a mobile-first web app for GPS-based tag games. The main page opens the live multiplayer version at live.html. It uses Supabase for accounts, lobbies, settings, tag confirmation, package collection, checkpoint progress, and location sharing.

## Current play features

- Create or join a lobby with an eight-character code.
- Guest login and passwordless email magic links. A new account is created when needed; optional phone login requires an SMS provider.
- Sisten, Catch, Infection, and checkpoint rounds.
- Round length, optional countdown, hunter location reveal timing, and map visibility controls.
- Search for places in Norway and draw a play area on an OpenStreetMap street map.
- Boundary warnings with an optional out or hunter penalty after ten seconds outside.
- Optional packages with random advantage/disadvantage cards and up to ten checkpoints.
- Full-screen round map, GPS sharing, touch confirmation for tags, and post-round distance summary.
- Anonymized zone count mode, so the hunter can see how many sharing players are in the zone without seeing their names or map points.
- The host starts once there are at least two players and a drawn play area.

## Supabase setup

See [SUPABASE_SETUP.md](SUPABASE_SETUP.md). An existing project must run supabase-upgrade.sql once before the new multiplayer features work. For a brand-new project, run supabase-schema.sql first and then supabase-upgrade.sql.

## Pages

- index.html: redirects to the live game.
- live.html: live multiplayer app.
- demo.html: earlier visual prototype. Its player positions and game events are simulated and do not connect phones.
