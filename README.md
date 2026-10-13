# Deck Curfew

**Schedule lock** for Steam Deck via [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader).

Outside your play window, running games are **hard-quit** and new launches are blocked. Once you **lock** curfew or start a session, you cannot edit the schedule or turn it off in the plugin UI until the commitment ends.

> **Status:** early v0.2 — works in principle; test on your Deck before relying on it.

## Features

- **Timed sessions:** block all games for a period — start now, or after a delay (handy for testing)
- Weekday / weekend “block after” schedule + long schedule locks
- Warning toast before session/cutoff
- Hard quit via Steam `TerminateApp`
- Launch block via `RunGame` patch
- No in-plugin cancel/unlock while a session or lock is active (wait for commitment end)

## Honest limits

The Deck is an open device. Uninstalling this plugin, deleting its settings, or playing outside Steam can bypass Curfew. This is a commitment aid on an open device — not parental TPM lockdown.

Steam Families already offers play windows for **Child** accounts. Deck Curfew is for **same-account self-control** in Game Mode.

## Install (ZIP)

On a machine with Node + pnpm 9:

```bash
pnpm i
pnpm run package
```

That writes `out/DeckCurfew-v0.2.0.zip`. Copy it to the Deck, then:

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

## Reference

Conceptually similar to [Freedom](https://freedom.to) (scheduled / session-based blocking with a hard-to-cheat lock). Deck Curfew is an independent Decky plugin for Steam Deck Game Mode and is not affiliated with Freedom.

## License

BSD-3-Clause. Based on the [Decky Plugin Template](https://github.com/SteamDeckHomebrew/decky-plugin-template).
