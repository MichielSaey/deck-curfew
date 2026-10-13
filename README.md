# Deck Curfew

Freedom-style **schedule lock** for Steam Deck via [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader).

Outside your play window, running games are **hard-quit** and new launches are blocked. Once you **lock** curfew, you cannot edit the schedule or turn it off in the plugin UI until the commitment ends.

> **Status:** early v0.1 — works in principle; test on your Deck before relying on it.

## Features

- **Freedom-style sessions:** block all games for a period — start now, or after a delay (great for testing)
- Weekday / weekend “block after” schedule + long schedule locks
- Warning toast before session/cutoff
- Hard quit via Steam `TerminateApp`
- Launch block via `RunGame` patch
- No in-plugin cancel/unlock while a session or lock is active (wait for commitment end)

## Honest limits

The Deck is an open device. Uninstalling this plugin, deleting its settings, or playing outside Steam can bypass Curfew. That matches Freedom’s commitment model on an open PC — not parental TPM lockdown.

Steam Families already offers play windows for **Child** accounts. Deck Curfew is for **same-account self-control** in Game Mode.

## Install (ZIP)

On a machine with Node + pnpm 9 and `zip`:

```bash
pnpm i
pnpm run package
```

That writes `out/DeckCurfew-v0.1.0.zip`. Copy it to the Deck, then:

**Decky → settings → Developer → Install Plugin from ZIP**

Reload Decky if it does not appear. Store submission comes later once it’s battle-tested.

## Develop

```bash
pnpm i
pnpm run build
pnpm test
pnpm run package   # installable ZIP → out/
```

Frontend changes require a rebuild. Backend (`main.py`, `py_modules/`) is picked up on Decky reload.

## License

BSD-3-Clause. Based on the [Decky Plugin Template](https://github.com/SteamDeckHomebrew/decky-plugin-template).
