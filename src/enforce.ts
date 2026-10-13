import { toaster } from "@decky/api";
import { Router, replacePatch, callOriginal } from "@decky/ui";
import type { CurfewStatus } from "./types";

declare const SteamClient: {
  Apps: {
    TerminateApp: (appId: number | string, param1: boolean) => void;
    RunGame: (...args: unknown[]) => unknown;
  };
};

type PatchHandle = { unpatch: () => void };

let blockLaunches = false;
let runGamePatch: PatchHandle | null = null;
let lastWarnKey: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function terminateRunningGames(): void {
  const apps = Router.RunningApps ?? [];
  for (const app of apps) {
    try {
      // AppOverview typically exposes appid
      const appId = app.appid;
      if (appId != null && appId !== "") {
        SteamClient.Apps.TerminateApp(appId, true);
      }
    } catch (err) {
      console.error("Deck Curfew: failed to terminate app", err);
    }
  }
}

function ensureLaunchPatch(): void {
  if (runGamePatch) return;
  try {
    runGamePatch = replacePatch(SteamClient.Apps, "RunGame", () => {
      if (blockLaunches) {
        toaster.toast({
          title: "Deck Curfew",
          body: "Play window closed. Games are blocked until the next allow window.",
          duration: 4000,
        });
        return undefined;
      }
      return callOriginal;
    }) as PatchHandle;
  } catch (err) {
    console.error("Deck Curfew: failed to patch RunGame", err);
  }
}

function maybeWarn(status: CurfewStatus): void {
  if (!status.shouldWarn || !status.cutoffAt) return;
  if (lastWarnKey === status.cutoffAt) return;
  lastWarnKey = status.cutoffAt;
  const mins = status.minutesToCutoff ?? status.warnMinutes;
  toaster.toast({
    title: "Deck Curfew",
    body: `Play window ends in ${mins} minute${mins === 1 ? "" : "s"}. Games will quit.`,
    duration: 5000,
  });
}

export function applyStatus(status: CurfewStatus): void {
  blockLaunches = status.shouldBlockPlay;
  ensureLaunchPatch();
  maybeWarn(status);
  if (status.shouldBlockPlay) {
    terminateRunningGames();
  }
}

export type StatusFetcher = () => Promise<CurfewStatus>;

export function startEnforcement(fetchStatus: StatusFetcher, intervalMs = 10000): void {
  ensureLaunchPatch();
  const tick = async () => {
    try {
      const status = await fetchStatus();
      applyStatus(status);
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
}
