# Deck Curfew

Freedom-style **schedule lock** for Steam Deck via [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader).

Outside your play window, running games are **hard-quit** and new launches are blocked. Once you **lock** curfew, you cannot edit the schedule or turn it off in the plugin UI until the commitment ends.

> **Status:** early v0.1 — works in principle; test on your Deck before relying on it.

## Features

- Weekday / weekend “block after” times (24h `HH:MM`)
- Freedom-style lock presets: until tomorrow 08:00, 3 days, or 7 days
- Warning toast before cutoff
- Hard quit via Steam `TerminateApp`
- Launch block via `RunGame` patch
- No in-plugin unlock while locked (wait for commitment end)

## Honest limits

The Deck is an open device. Uninstalling this plugin, deleting its settings, or playing outside Steam can bypass Curfew. That matches Freedom’s commitment model on an open PC — not parental TPM lockdown.

Steam Families already offers play windows for **Child** accounts. Deck Curfew is for **same-account self-control** in Game Mode.

## Install (from source / ZIP)

1. Build on a machine with Node + pnpm 9:

   ```bash
   pnpm i
   pnpm run build
   ```

2. Zip the plugin so the archive root contains the plugin folder (with `dist/`, `main.py`, `plugin.json`, `package.json`, `py_modules/`, …).

3. On the Deck: Decky → settings → Developer → **Install Plugin from ZIP**.

Store submission comes later once it’s battle-tested.

## Develop

```bash
pnpm i
pnpm run build
pnpm test
```

Frontend changes require a rebuild. Backend (`main.py`, `py_modules/`) is picked up on Decky reload.

## License

BSD-3-Clause. Based on the [Decky Plugin Template](https://github.com/SteamDeckHomebrew/decky-plugin-template).
