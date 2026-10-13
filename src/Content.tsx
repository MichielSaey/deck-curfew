import {
  ButtonItem,
  ConfirmModal,
  PanelSection,
  PanelSectionRow,
  TextField,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { cancelPendingSession, getStatus, lockPreset, startSession, updateSchedule } from "./api";
import { applyStatus } from "./enforce";
import type { CurfewStatus } from "./types";

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

export function Content() {
  const [status, setStatus] = useState<CurfewStatus | null>(null);
  const [blockAfter, setBlockAfter] = useState("21:00");
  const [weekendBlockAfter, setWeekendBlockAfter] = useState("22:00");
  const [warnMinutes, setWarnMinutes] = useState("5");
  const [sessionDuration, setSessionDuration] = useState("5");
  const [sessionDelay, setSessionDelay] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const next = await getStatus();
      setStatus(next);
      setBlockAfter(next.settings.blockAfter);
      setWeekendBlockAfter(next.settings.weekendBlockAfter);
      setWarnMinutes(String(next.settings.warnMinutes));
      setError(null);
      void applyStatus(next);
      setNowMs(Date.now());
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Local 1s tick for smooth countdown between backend polls
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
    setBusy(true);
    try {
      const next = await updateSchedule({
        mode: "block_after",
        blockAfter: blockAfter.trim(),
        weekendBlockAfter: weekendBlockAfter.trim(),
        warnMinutes: warn,
      });
      setStatus(next);
      void applyStatus(next);
      setError(null);
      toaster.toast({ title: "Deck Curfew", body: "Schedule saved." });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmSession = (duration: number, delay: number) => {
    const when =
      delay <= 0
        ? `now for ${formatDuration(duration)}`
        : `after a ${formatDuration(delay)} countdown, then for ${formatDuration(duration)}`;
    showModal(
      <ConfirmModal
        strTitle={delay > 0 ? "Arm curfew session?" : "Start curfew session?"}
        strDescription={
          delay > 0
            ? `A countdown will run first — the session is not active yet. Then games will be blocked ${when}. Once active, you cannot cancel.`
            : `Games will be blocked ${when}. You cannot cancel once started.`
        }
        strOKButtonText={delay > 0 ? "Arm session" : "Start session"}
        onOK={async () => {
          setBusy(true);
          try {
            const next = await startSession(duration, delay);
            setStatus(next);
            void applyStatus(next);
            setError(null);
            toaster.toast({
              title: "Deck Curfew",
              body:
                delay > 0
                  ? `Countdown started — session activates in ${formatDuration(delay)}.`
                  : "Session started.",
            });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
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

  const confirmLock = (preset: string, label: string) => {
    showModal(
      <ConfirmModal
        strTitle="Lock schedule curfew?"
        strDescription={`Settings freeze until ${label}. Play follows your block-after schedule. No unlock button.`}
        strOKButtonText="Lock"
        onOK={async () => {
          setBusy(true);
          try {
            const next = await lockPreset(preset);
            setStatus(next);
            void applyStatus(next);
            setError(null);
            toaster.toast({ title: "Deck Curfew", body: `Locked until ${label}.` });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  };

  const onCancelPending = async () => {
    setBusy(true);
    try {
      const next = await cancelPendingSession();
      setStatus(next);
      void applyStatus(next);
      setError(null);
      toaster.toast({ title: "Deck Curfew", body: "Upcoming session cancelled." });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const locked = status?.locked ?? false;
  const phase = status?.sessionPhase ?? "none";

  const pendingSeconds =
    phase === "pending" ? secondsUntil(status?.sessionStartsAt, nowMs) : null;
  const activeSeconds =
    phase === "active" ? secondsUntil(status?.lockedUntil, nowMs) : null;

  const statusDisplay =
    phase === "pending" && pendingSeconds != null
      ? `Countdown ${formatCountdown(pendingSeconds)} — session not active yet`
      : phase === "active" && activeSeconds != null
        ? `Session active — ${formatCountdown(activeSeconds)} left`
        : (status?.statusLine ?? "Loading…");

  return (
    <>
      <PanelSection title="Status">
        <PanelSectionRow>
          <div style={{ padding: "4px 0", fontSize: phase === "pending" || phase === "active" ? "1.15em" : undefined }}>
            {statusDisplay}
          </div>
        </PanelSectionRow>
        {status?.lockLine && (
          <PanelSectionRow>
            <div style={{ padding: "4px 0", opacity: 0.85 }}>{status.lockLine}</div>
          </PanelSectionRow>
        )}
        {error && (
          <PanelSectionRow>
            <div style={{ color: "#f66", padding: "4px 0" }}>{error}</div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {phase === "pending" && (
        <PanelSection title="Upcoming session">
          <PanelSectionRow>
            <div style={{ padding: "4px 0" }}>
              Countdown only — games are still allowed. The session becomes active when
              the timer hits zero.
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <div style={{ padding: "8px 0", fontSize: "1.6em", fontWeight: 600 }}>
              {pendingSeconds != null ? formatCountdown(pendingSeconds) : "—"}
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => void onCancelPending()}>
              Cancel upcoming session
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {phase === "active" || (locked && phase === "none") ? (
        <PanelSection title={phase === "active" ? "Session active" : "Locked"}>
          <PanelSectionRow>
            <div style={{ padding: "4px 0" }}>
              {phase === "active"
                ? "Games are blocked. Wait for the timer to end; there is no unlock."
                : "Settings are frozen until the commitment ends. No in-plugin disable."}
            </div>
          </PanelSectionRow>
          {phase === "active" && activeSeconds != null && (
            <PanelSectionRow>
              <div style={{ padding: "8px 0", fontSize: "1.6em", fontWeight: 600 }}>
                {formatCountdown(activeSeconds)}
              </div>
            </PanelSectionRow>
          )}
        </PanelSection>
      ) : phase !== "pending" ? (
        <>
          <PanelSection title="Start session">
            <PanelSectionRow>
              <div style={{ padding: "4px 0", opacity: 0.85 }}>
                Block all games for a period. Start now, or after a countdown
                (handy for testing — launch a game first).
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => confirmSession(2, 0)}
              >
                Now · 2 min (quick test)
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => confirmSession(5, 0)}
              >
                Now · 5 min
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => confirmSession(5, 1)}
              >
                Countdown 1 min · then 5 min
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => confirmSession(15, 0)}
              >
                Now · 15 min
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
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
              <ButtonItem layout="below" disabled={busy} onClick={startCustomSession}>
                Start custom session
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title="Daily schedule">
            <PanelSectionRow>
              <TextField
                label="Weekday block after (HH:MM)"
                value={blockAfter}
                onChange={(e) => setBlockAfter(e.target.value)}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <TextField
                label="Weekend block after (HH:MM)"
                value={weekendBlockAfter}
                onChange={(e) => setWeekendBlockAfter(e.target.value)}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <TextField
                label="Warn minutes before cutoff"
                value={warnMinutes}
                onChange={(e) => setWarnMinutes(e.target.value)}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => void saveSchedule()} disabled={busy}>
                Save schedule
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>

          <PanelSection title="Lock schedule (long)">
            <PanelSectionRow>
              <div style={{ padding: "4px 0", opacity: 0.85 }}>
                Freeze settings and enforce the daily schedule until the commitment ends.
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => confirmLock("tomorrow_8", "tomorrow 08:00")}
              >
                Lock until tomorrow 08:00
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => confirmLock("days_3", "3 days from now")}
              >
                Lock for 3 days
              </ButtonItem>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={() => confirmLock("days_7", "7 days from now")}
              >
                Lock for 7 days
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
        </>
      ) : null}

      <PanelSection title="About">
        <PanelSectionRow>
          <div style={{ padding: "4px 0", opacity: 0.75, fontSize: "0.9em" }}>
            Sessions hard-quit games for a set period. Escape hatches outside this plugin
            still exist (uninstall / Desktop Mode).
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
