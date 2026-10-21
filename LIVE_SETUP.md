# FunRun flerspillerbeta

`live.html` is the first Firebase-backed version of FunRun. It adds accounts, shared lobby codes, a round timer, tag confirmation, and optional GPS sharing. The existing `index.html` demo remains unchanged until a Firebase project has been configured.

## Set up Firebase

1. Create a Firebase project at <https://console.firebase.google.com/>.
2. Add a Web app in the project settings and copy its web configuration into `firebase-config.js`.
3. In **Authentication → Sign-in method**, turn on **Email/Password**.
4. In **Authentication → Settings → Authorized domains**, add `johansuperkulma.github.io`.
5. Create a **Realtime Database** in a European region. Copy its database URL into `firebase-config.js` as `databaseURL`.
6. In the database's **Rules** tab, paste the contents of `database.rules.json` and publish them.
7. Keep the web configuration in `firebase-config.js` on the site. It is public browser configuration. Never add a Firebase service-account JSON file or private key to this repository.
8. Open `live.html` over the site's HTTPS address. Create an account on one phone, another account on a second phone, then create a lobby and join with its code.

The database rules limit room data to members, allow only the host to change the round, and let hunters read other players' GPS points only during the configured reveal window. A player has to press **Start GPS** before their phone starts sharing a location. Stopping GPS removes the last uploaded point.

This is an early multiplayer beta. It does not yet include drawing a custom play boundary or checking whether players leave that boundary. Do not use it as a public release until the Firebase rules and two-phone game flow have been reviewed with the actual Firebase project.
