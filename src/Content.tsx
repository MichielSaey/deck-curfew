import {
  ButtonItem,
  ConfirmModal,
  PanelSection,
  PanelSectionRow,
  TextField,
  ToggleField,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPendingSession,
  checkForUpdate,
  getStatus,
  installUpdate,
  lockPreset,
  setAutoUpdate,
  startSession,
  updateSchedule,
} from "./api";
import { applyStatus } from "./enforce";
import type { CurfewStatus, UpdateInfo } from "./types";
import { PLUGIN_VERSION } from "./version";

function isHhMm(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function secondsUntil(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.floor((target - nowMs) / 1000));
}

function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Content() {
  const [status, setStatus] = useState<CurfewStatus | null>(null);
  const [blockAfter, setBlockAfter] = useState("21:00");
  const [weekendBlockAfter, setWeekendBlockAfter] = useState("22:00");
  const [warnMinutes, setWarnMinutes] = useState("5");
  const [sessionDuration, setSessionDuration] = useState("5");
  const [sessionDelay, setSessionDelay] = useState("0");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const fieldsSynced = useRef(false);

  const applyBackendStatus = useCallback((next: CurfewStatus, syncFields = false) => {
    setStatus(next);
    if (syncFields || !fieldsSynced.current) {
      setBlockAfter(next.settings.blockAfter);
      setWeekendBlockAfter(next.settings.weekendBlockAfter);
      setWarnMinutes(String(next.settings.warnMinutes));
      fieldsSynced.current = true;
    }
    if (next.update) setUpdateInfo(next.update);
    setNowMs(Date.now());
    void applyStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getStatus();
      applyBackendStatus(next);
      setError(null);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyBackendStatus]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const saveSchedule = async () => {
    if (!isHhMm(blockAfter) || !isHhMm(weekendBlockAfter)) {
      setError("Times must be HH:MM (24h).");
      return;
    }
    const warn = Number(warnMinutes);
    if (!Number.isFinite(warn) || warn < 0 || warn > 120) {
      setError("Warn minutes must be 0–120.");
      return;
    }
    setBusy("save");
    try {
      const next = await updateSchedule({
        mode: "block_after",
        blockAfter: blockAfter.trim(),
        weekendBlockAfter: weekendBlockAfter.trim(),
        warnMinutes: warn,
      });
      applyBackendStatus(next, true);
      setError(null);
      const note = next.scheduleLocked
        ? `Schedule saved & enforcing — ${next.scheduleSummary}`
        : `Schedule saved — ${next.scheduleSummary}. Turn on Lock schedule to enforce.`;
      setSaveNote(note);
      toaster.toast({ title: "Deck Curfew", body: note });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const confirmSession = (duration: number, delay: number) => {
    showModal(
      <ConfirmModal
        strTitle={delay > 0 ? "Arm curfew session?" : "Start curfew session?"}
        strDescription={
          delay > 0
            ? `Countdown ${formatDuration(delay)}, then block all games for ${formatDuration(duration)}. Cancel anytime before it starts.`
            : `Block all games for ${formatDuration(duration)}. No cancel once started.`
        }
        strOKButtonText={delay > 0 ? "Arm session" : "Start session"}
        onOK={async () => {
          setBusy("session");
          try {
            const next = await startSession(duration, delay);
            applyBackendStatus(next);
            setError(null);
            setSaveNote(null);
            toaster.toast({
              title: "Deck Curfew",
              body:
                delay > 0
                  ? `Countdown started — activates in ${formatDuration(delay)}.`
                  : "Session started — games blocked.",
            });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(null);
          }
        }}
      />
    );
  };

  const startCustomSession = () => {
    const duration = Number(sessionDuration);
    const delay = Number(sessionDelay);
    if (!Number.isFinite(duration) || duration < 1 || duration > 24 * 60) {
      setError("Duration must be 1–1440 minutes.");
      return;
    }
    if (!Number.isFinite(delay) || delay < 0 || delay > 24 * 60) {
      setError("Delay must be 0–1440 minutes.");
      return;
    }
    confirmSession(Math.floor(duration), Math.floor(delay));
  };

  const enableScheduleLock = (preset: string, label: string) => {
    showModal(
      <ConfirmModal
        strTitle="Lock schedule?"
        strDescription={`Enforce weekday/weekend cutoffs and freeze settings until ${label}. You cannot turn this off early from the plugin.`}
        strOKButtonText="Lock schedule"
        onOK={async () => {
          setBusy("lock");
          try {
            const next = await lockPreset(preset);
            applyBackendStatus(next, true);
            setError(null);
            setSaveNote(`Schedule locked until ${label}`);
            toaster.toast({
              title: "Deck Curfew",
              body: `Schedule locked — ${next.statusLine}`,
            });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(null);
          }
        }}
      />
    );
  };

  const onLockToggle = (enabled: boolean) => {
    if (!enabled) {
      toaster.toast({
        title: "Deck Curfew",
        body: "Schedule lock cannot be turned off early — wait for the commitment to end.",
      });
      return;
    }
    enableScheduleLock("tomorrow_8", "tomorrow 08:00");
  };

  const onCancelPending = async () => {
    setBusy("cancel");
    try {
      const next = await cancelPendingSession();
      applyBackendStatus(next);
      setError(null);
      toaster.toast({ title: "Deck Curfew", body: "Upcoming session cancelled." });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onCheckUpdate = async () => {
    setBusy("update");
    try {
      const info = await checkForUpdate();
      setUpdateInfo(info);
      setError(null);
      toaster.toast({
        title: "Deck Curfew",
        body: info.updateAvailable
          ? `Update available: v${info.latest}`
          : `Up to date (v${info.current || PLUGIN_VERSION})`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onInstallUpdate = () => {
    showModal(
      <ConfirmModal
        strTitle="Install update?"
        strDescription="Downloads the latest release from GitHub and reloads Decky. Not available while a session or lock is active."
        strOKButtonText="Install"
        onOK={async () => {
          setBusy("update");
          try {
            const info = await installUpdate();
            setUpdateInfo(info);
            setError(null);
            toaster.toast({
              title: "Deck Curfew",
              body: `Installed v${info.installedVersion ?? info.latest}. Reloading…`,
            });
            await refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(null);
          }
        }}
      />
    );
  };

  const onToggleAutoUpdate = async (enabled: boolean) => {
    setBusy("autoupdate");
    try {
      const next = await setAutoUpdate(enabled);
      applyBackendStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const phase = status?.sessionPhase ?? "none";
  const scheduleLocked = status?.scheduleLocked ?? false;
  const sessionBusy = phase === "pending" || phase === "active";
  const version =
    status?.pluginVersion ||
    updateInfo?.current ||
    PLUGIN_VERSION;
  const autoUpdate = status?.settings.autoUpdate ?? true;

  const pendingSeconds =
    phase === "pending" ? secondsUntil(status?.sessionStartsAt, nowMs) : null;
  const activeSeconds =
    phase === "active" ? secondsUntil(status?.lockedUntil, nowMs) : null;

  let statusDisplay = status?.statusLine ?? (error ? "Could not load status" : "Loading status…");
  if (phase === "pending" && pendingSeconds != null) {
    statusDisplay = `Session starts in ${formatCountdown(pendingSeconds)}`;
  } else if (phase === "active" && activeSeconds != null) {
    statusDisplay = `Session active — ${formatCountdown(activeSeconds)} left`;
  }

  const nextDisplay =
    phase === "pending" && status?.lockedUntil
      ? `Then blocks until ${formatWhen(status.lockedUntil)}`
      : phase === "active"
        ? status?.lockLine
        : status?.nextLine ||
          (status?.nextBlockAt
            ? `Next cutoff ${formatWhen(status.nextBlockAt)}`
            : status?.scheduleSummary);

  const scheduleReadOnly = scheduleLocked || sessionBusy;

  return (
    <>
      <PanelSection title="Status">
        <PanelSectionRow>
          <div
            style={{
              padding: "6px 0",
              fontSize: sessionBusy || scheduleLocked ? "1.15em" : undefined,
              fontWeight: 600,
            }}
          >
            {statusDisplay}
          </div>
        </PanelSectionRow>
        {nextDisplay && (
          <PanelSectionRow>
            <div style={{ padding: "2px 0", opacity: 0.9 }}>{nextDisplay}</div>
          </PanelSectionRow>
        )}
        {status?.lockLine && phase !== "active" && (
          <PanelSectionRow>
            <div style={{ padding: "2px 0", opacity: 0.8 }}>{status.lockLine}</div>
          </PanelSectionRow>
        )}
        {status?.scheduleSummary && (
          <PanelSectionRow>
            <div style={{ padding: "2px 0", opacity: 0.75, fontSize: "0.9em" }}>
              {status.scheduleSummary}
            </div>
          </PanelSectionRow>
        )}
        {saveNote && (
          <PanelSectionRow>
            <div style={{ padding: "4px 0", color: "#8f8" }}>{saveNote}</div>
          </PanelSectionRow>
        )}
        {error && (
          <PanelSectionRow>
            <div style={{ color: "#f66", padding: "4px 0" }}>{error}</div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => void refresh()} disabled={busy !== null}>
            Refresh status
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {phase === "pending" && (
        <PanelSection title="Upcoming session">
          <PanelSectionRow>
            <div style={{ padding: "4px 0" }}>
              Countdown only — games still allowed. Becomes a hard block at zero.
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <div style={{ padding: "8px 0", fontSize: "1.6em", fontWeight: 600 }}>
              {pendingSeconds != null ? formatCountdown(pendingSeconds) : "—"}
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={() => void onCancelPending()}
            >
              Cancel upcoming session
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {phase === "active" && (
        <PanelSection title="Session active">
          <PanelSectionRow>
            <div style={{ padding: "4px 0" }}>
              Games are blocked. Wait for the timer — there is no unlock.
            </div>
          </PanelSectionRow>
          {activeSeconds != null && (
            <PanelSectionRow>
              <div style={{ padding: "8px 0", fontSize: "1.6em", fontWeight: 600 }}>
                {formatCountdown(activeSeconds)}
              </div>
            </PanelSectionRow>
          )}
        </PanelSection>
      )}

      {phase !== "active" && (
        <PanelSection title="Daily schedule">
          <PanelSectionRow>
            <div style={{ padding: "4px 0", opacity: 0.85 }}>
              {scheduleLocked
                ? "Enforcing cutoffs. Settings frozen until the lock ends."
                : "Save your cutoffs, then lock the schedule to enforce them."}
            </div>
          </PanelSectionRow>
          {status?.nextBlockAt && (
            <PanelSectionRow>
              <div style={{ padding: "4px 0", fontWeight: 600 }}>
                {scheduleLocked ? "Next block: " : "Next block if locked: "}
                {formatWhen(status.nextBlockAt)}
              </div>
            </PanelSectionRow>
          )}
          <PanelSectionRow>
            <TextField
              label="Weekday block after (HH:MM)"
              value={blockAfter}
              disabled={scheduleReadOnly}
              onChange={(e) => setBlockAfter(e.target.value)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="Weekend block after (HH:MM)"
              value={weekendBlockAfter}
              disabled={scheduleReadOnly}
              onChange={(e) => setWeekendBlockAfter(e.target.value)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="Warn minutes before cutoff"
              value={warnMinutes}
              disabled={scheduleReadOnly}
              onChange={(e) => setWarnMinutes(e.target.value)}
            />
          </PanelSectionRow>
          {!scheduleReadOnly && (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                onClick={() => void saveSchedule()}
                disabled={busy !== null}
              >
                {busy === "save" ? "Saving…" : "Save schedule"}
              </ButtonItem>
            </PanelSectionRow>
          )}
          <PanelSectionRow>
            <ToggleField
              label="Lock schedule"
              description={
                scheduleLocked && status?.lockedUntil
                  ? `On — frozen until ${formatWhen(status.lockedUntil)}. Cannot turn off early.`
                  : "Off — cutoffs are saved but not enforced until you lock."
              }
              checked={scheduleLocked}
              disabled={busy !== null || phase === "pending"}
              onChange={(value: boolean) => onLockToggle(value)}
            />
          </PanelSectionRow>
          {!scheduleLocked && phase !== "pending" && (
            <>
              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  disabled={busy !== null}
                  onClick={() => enableScheduleLock("tomorrow_8", "tomorrow 08:00")}
                >
                  Lock until tomorrow 08:00
                </ButtonItem>
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  disabled={busy !== null}
                  onClick={() => enableScheduleLock("days_3", "3 days from now")}
                >
                  Lock for 3 days
                </ButtonItem>
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  disabled={busy !== null}
                  onClick={() => enableScheduleLock("days_7", "7 days from now")}
                >
                  Lock for 7 days
                </ButtonItem>
              </PanelSectionRow>
            </>
          )}
        </PanelSection>
      )}

      {phase === "none" && !scheduleLocked && (
        <PanelSection title="Timed session">
          <PanelSectionRow>
            <div style={{ padding: "4px 0", opacity: 0.85 }}>
              Block all games for a set period (separate from the daily schedule).
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={() => confirmSession(2, 0)}
            >
              Now · 2 min
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={() => confirmSession(5, 0)}
            >
              Now · 5 min
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={() => confirmSession(5, 1)}
            >
              Countdown 1 min · then 5 min
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={() => confirmSession(15, 0)}
            >
              Now · 15 min
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={() => confirmSession(30, 0)}
            >
              Now · 30 min
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="Custom duration (minutes)"
              value={sessionDuration}
              mustBeNumeric={true}
              onChange={(e) => setSessionDuration(e.target.value)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="Countdown before start (minutes, 0 = now)"
              value={sessionDelay}
              mustBeNumeric={true}
              onChange={(e) => setSessionDelay(e.target.value)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy !== null}
              onClick={startCustomSession}
            >
              Start custom session
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      <PanelSection title="Updates">
        <PanelSectionRow>
          <div style={{ padding: "4px 0" }}>
            Installed v{version}
            {updateInfo?.updateAvailable && updateInfo.latest
              ? ` · latest v${updateInfo.latest}`
              : updateInfo?.latest
                ? " · up to date"
                : ""}
          </div>
        </PanelSectionRow>
        {updateInfo?.error && (
          <PanelSectionRow>
            <div style={{ color: "#f66", padding: "4px 0", fontSize: "0.9em" }}>
              {updateInfo.error}
            </div>
          </PanelSectionRow>
        )}
        {!scheduleLocked && phase !== "active" && (
          <PanelSectionRow>
            <ToggleField
              label="Auto-update"
              description="Check GitHub Releases every few hours and install when unlocked."
              checked={autoUpdate}
              disabled={busy !== null}
              onChange={(value: boolean) => void onToggleAutoUpdate(value)}
            />
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy !== null}
            onClick={() => void onCheckUpdate()}
          >
            Check for updates
          </ButtonItem>
        </PanelSectionRow>
        {updateInfo?.updateAvailable && !scheduleLocked && phase !== "active" && (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy !== null} onClick={onInstallUpdate}>
              Install v{updateInfo.latest}
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="About">
        <PanelSectionRow>
          <div style={{ padding: "4px 0", opacity: 0.75, fontSize: "0.9em" }}>
            Deck Curfew v{PLUGIN_VERSION}. Escape hatches outside this plugin still exist
            (uninstall / Desktop Mode).
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
