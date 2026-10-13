import { toaster, callable } from "@decky/api";
import { Router, replacePatch, callOriginal } from "@decky/ui";
import type { CurfewStatus } from "./types";

type PatchHandle = { unpatch: () => void };
type Unregisterable = { unregister: () => void };

type SteamApps = {
  TerminateApp?: (appId: string, force: boolean) => void;
  RunGame?: (...args: unknown[]) => unknown;
  CancelGameAction?: (gameActionId: number) => void;
  CancelLaunch?: (appId: string) => void;
  RegisterForGameActionStart?: (
    callback: (gameActionId: number, appId: string, action: string, source: number) => void
  ) => Unregisterable;
};

function getSteamApps(): SteamApps | null {
  try {
    // SteamClient is a Game Mode global
    const sc = (globalThis as unknown as { SteamClient?: { Apps?: SteamApps } }).SteamClient;
    return sc?.Apps ?? null;
  } catch {
    return null;
  }
}

const enforceNow = callable<[], CurfewStatus & { killed?: unknown[] }>("enforce_now");

let blockLaunches = false;
let runGamePatch: PatchHandle | null = null;
let gameActionReg: Unregisterable | null = null;
let lastWarnKey: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastToastBlock = 0;

function toastBlocked(): void {
  const now = Date.now();
  if (now - lastToastBlock < 2500) return;
  lastToastBlock = now;
  toaster.toast({
    title: "Deck Curfew",
    body: "Session active — games are blocked.",
    duration: 3500,
  });
}

function terminateRunningGames(): void {
  const appsApi = getSteamApps();
  const running = Router.RunningApps ?? [];
  for (const app of running) {
    try {
      const appId = String(app.appid ?? "");
      if (!appId) continue;
      appsApi?.TerminateApp?.(appId, true);
      appsApi?.CancelLaunch?.(appId);
    } catch (err) {
      console.error("Deck Curfew: TerminateApp failed", err);
    }
  }
}

function ensureLaunchPatch(): void {
  const appsApi = getSteamApps();
  if (!appsApi?.RunGame) {
    console.warn("Deck Curfew: SteamClient.Apps.RunGame not available yet");
    return;
  }

  // Re-apply if Steam replaced the method out from under us
  if (runGamePatch) {
    try {
      const current = appsApi.RunGame as unknown as { __deckyPatch?: unknown };
      if (current?.__deckyPatch) return;
      runGamePatch = null;
    } catch {
      runGamePatch = null;
    }
  }

  try {
    runGamePatch = replacePatch(appsApi, "RunGame", (_args: unknown[]) => {
      if (blockLaunches) {
        console.log("Deck Curfew: blocked RunGame", _args?.[0]);
        toastBlocked();
        // Returning anything other than callOriginal skips the launch
        return null;
      }
      return callOriginal;
    }) as PatchHandle;
    console.log("Deck Curfew: RunGame patch installed");
  } catch (err) {
    console.error("Deck Curfew: failed to patch RunGame", err);
  }
}

function ensureGameActionHook(): void {
  if (gameActionReg) return;
  const appsApi = getSteamApps();
  if (!appsApi?.RegisterForGameActionStart) return;

  try {
    gameActionReg = appsApi.RegisterForGameActionStart((gameActionId, appId, action) => {
      if (!blockLaunches) return;
      console.log("Deck Curfew: cancelling game action", gameActionId, appId, action);
      try {
        appsApi.CancelGameAction?.(gameActionId);
        appsApi.TerminateApp?.(String(appId), true);
        appsApi.CancelLaunch?.(String(appId));
      } catch (err) {
        console.error("Deck Curfew: cancel game action failed", err);
      }
      toastBlocked();
      void enforceNow().catch(() => undefined);
    });
    console.log("Deck Curfew: game action hook installed");
  } catch (err) {
    console.error("Deck Curfew: RegisterForGameActionStart failed", err);
  }
}

function maybeWarn(status: CurfewStatus): void {
  if (!status.shouldWarn || !status.cutoffAt) return;
  if (lastWarnKey === status.cutoffAt) return;
  lastWarnKey = status.cutoffAt;
  const mins = status.minutesToCutoff ?? status.warnMinutes;
  const body =
    status.sessionPhase === "pending"
      ? `Curfew session starts in ${mins} minute${mins === 1 ? "" : "s"}.`
      : `Play window ends in ${mins} minute${mins === 1 ? "" : "s"}. Games will quit.`;
  toaster.toast({
    title: "Deck Curfew",
    body,
    duration: 5000,
  });
}

export async function applyStatus(status: CurfewStatus): Promise<void> {
  blockLaunches = Boolean(status.shouldBlockPlay);
  ensureLaunchPatch();
  ensureGameActionHook();
  maybeWarn(status);
  if (status.shouldBlockPlay) {
    terminateRunningGames();
    try {
      await enforceNow();
    } catch (err) {
      console.error("Deck Curfew: enforce_now failed", err);
    }
  }
}

export type StatusFetcher = () => Promise<CurfewStatus>;

export function startEnforcement(fetchStatus: StatusFetcher, intervalMs = 3000): void {
  const tick = async () => {
    try {
      ensureLaunchPatch();
      ensureGameActionHook();
      const status = await fetchStatus();
      await applyStatus(status);
    } catch (err) {
      console.error("Deck Curfew: status poll failed", err);
    }
  };
  void tick();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void tick(), intervalMs);
}

export function stopEnforcement(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  blockLaunches = false;
  if (runGamePatch) {
    try {
      runGamePatch.unpatch();
    } catch (err) {
      console.error("Deck Curfew: unpatch failed", err);
    }
    runGamePatch = null;
  }
  if (gameActionReg) {
    try {
      gameActionReg.unregister();
    } catch {
      /* ignore */
    }
    gameActionReg = null;
  }
}
