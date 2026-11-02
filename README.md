# Boss Battle

**Boss Battle is a chat-vs-streamer boss fight for Twitch.** Viewers team up in chat to damage a giant boss with messages, emotes, and `!attack`, while the streamer fights back from a control panel or with broadcaster-only chat commands. A transparent OBS overlay shows the boss, health, taunts, damage leaderboard, Twitch event effects, and the defeat summary. Run it in mock mode to demo everything without a live stream.

## Features

- Twitch chat damage: regular messages, caps/emotes, and cooldown-limited `!attack`.
- Streamer actions: **I DIED**, **I WON A ROUND**, and **CLUTCH**; broadcaster chat commands `!died`, `!won`, and `!clutch` do the same.
- Custom boss name, emoji, max HP, damage values, and taunts saved in `settings.json`.
- Twitch EventSub effects for raids, subscriptions/resubscriptions, gift subscriptions, and cheers/bits.
- Mock chat and event buttons for an offline demo.
- Transparent overlay with taunts, damage numbers, clutch countdown, top five, MVP/Boss Slayer titles, and defeat summary.

## Requirements

- Node.js 18 or newer (includes npm).
- No Twitch account or credentials needed for mock mode.

## Setup and run

Clone the repository, then open a terminal in the project folder.

### Windows PowerShell

```powershell
git clone https://github.com/YOUR-USERNAME/boss-battle.git
cd boss-battle
Copy-Item .env.example .env
npm install
.\start.ps1
```

### macOS

```sh
git clone https://github.com/YOUR-USERNAME/boss-battle.git
cd boss-battle
cp .env.example .env
npm install
chmod +x start.sh
./start.sh
```

### Linux

```sh
git clone https://github.com/YOUR-USERNAME/boss-battle.git
cd boss-battle
cp .env.example .env
npm install
chmod +x start.sh
./start.sh
```

The start scripts set `MOCK=true` and run the dev server. Keep the terminal open while you use the app; press Ctrl+C there to stop it. Mock mode generates chat automatically, and the control panel provides buttons for streamer actions, broadcaster commands, raids, subs, gift subs, and cheers.

Open these pages using the same host and port:

- Control panel: `http://localhost:3000/control.html`
- OBS overlay: `http://localhost:3000/overlay.html`
- Chat feed: `http://localhost:3000/`

## Configure the port

Edit `PORT` in `.env`. The default is `3000`; for example, set `PORT=3001` and use `http://localhost:3001/control.html` and `http://localhost:3001/overlay.html`. The pages connect to the server using their current URL, so the browser pages do not need code changes when the port changes.

You can also start the dev server directly with `npm run dev`. Ensure `.env` contains `MOCK=true` for an offline demo.

## Use the control panel

Open `/control.html` on the same port as the server.

- **I DIED** restores 15% of the boss's max HP and shows a taunt.
- **I WON A ROUND** removes 10% of max HP.
- **CLUTCH** stuns the boss for five seconds and doubles chat damage for that time.
- In mock mode, use the mock command buttons to exercise `!died`, `!won`, and `!clutch` as broadcaster chat.
- Use the mock Twitch buttons to simulate raids, subs/resubs, gift subs, and cheers. Raid damage scales with raider count; a sub doubles chat damage for ten seconds; gifts cause a meteor strike; cheer damage is bits divided by ten.
- Save boss name, emoji, max HP, damage values, and taunt lines in Boss Settings. Changes persist in `settings.json` and update the overlay live.

`settings.json` stores gameplay settings only; Twitch tokens stay in memory and are not written to that file.

## Add the overlay to OBS

1. Start the server and open OBS.
2. Add a **Browser Source** to your scene.
3. Set the URL to `http://localhost:3000/overlay.html` (replace `3000` if you changed `PORT`).
4. Set width to **1920** and height to **1080**.

The overlay page has a transparent background, so it layers over the stream scene.

## Connect to a real Twitch channel

For chat only, edit `.env` and set:

```dotenv
MOCK=false
TWITCH_CHANNEL=your_channel_name
```

Then run `npm run dev`. Chat connects anonymously through Twitch IRC; the client ID and secret are not needed just to read chat.

To receive real raids, subscriptions, gift subs, and cheers through EventSub, also create a Twitch developer application and set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `TWITCH_REDIRECT_URI` in `.env`. Register the exact redirect URL in the Twitch application's OAuth settings. For example, with `PORT=3001`, use `http://localhost:3001/auth/callback` for both the Twitch app redirect and `TWITCH_REDIRECT_URI`. Start the app, open `/control.html`, select **Connect Twitch EventSub**, and sign in as the broadcaster named by `TWITCH_CHANNEL`. The app requests `bits:read` and `channel:read:subscriptions`. Twitch EventSub's WebSocket transport requires a user access token; the app keeps it in memory, so reconnect after restarting the server or when Twitch expires the token.

## How this was built with Codex

The project was built in small steps in Codex: first a local Twitch chat listener and mock chat feed, then boss damage rules and the OBS overlay, then streamer controls, saved customization, and Twitch EventSub. The server uses Node.js and TypeScript with Express, WebSockets, and tmi.js; the overlay and control panel are small local HTML pages. The visuals use CSS and emoji, and taunts are selected from the saved rules-based list.
