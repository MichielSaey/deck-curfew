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
import { getStatus, lockPreset, startSession, updateSchedule } from "./api";
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

export function Content() {
  const [status, setStatus] = useState<CurfewStatus | null>(null);
  const [blockAfter, setBlockAfter] = useState("21:00");
  const [weekendBlockAfter, setWeekendBlockAfter] = useState("22:00");
  const [warnMinutes, setWarnMinutes] = useState("5");
  const [sessionDuration, setSessionDuration] = useState("5");
  const [sessionDelay, setSessionDelay] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getStatus();
      setStatus(next);
      setBlockAfter(next.settings.blockAfter);
      setWeekendBlockAfter(next.settings.weekendBlockAfter);
      setWarnMinutes(String(next.settings.warnMinutes));
      setError(null);
      applyStatus(next);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 10000);
    return () => clearInterval(id);
  }, [refresh]);

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
      applyStatus(next);
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
        : `in ${formatDuration(delay)}, then block for ${formatDuration(duration)}`;
    showModal(
      <ConfirmModal
        strTitle="Start curfew session?"
        strDescription={`Games will be blocked ${when}. You cannot cancel once started.`}
        strOKButtonText="Start session"
        onOK={async () => {
          setBusy(true);
          try {
            const next = await startSession(duration, delay);
            setStatus(next);
            applyStatus(next);
            setError(null);
            toaster.toast({
              title: "Deck Curfew",
              body: delay > 0 ? `Session armed — starts in ${formatDuration(delay)}.` : "Session started.",
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
            applyStatus(next);
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

  const locked = status?.locked ?? false;
  const phase = status?.sessionPhase ?? "none";

  return (
    <>
      <PanelSection title="Status">
        <PanelSectionRow>
          <div style={{ padding: "4px 0" }}>
            {status?.statusLine ?? "Loading…"}
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

      {locked ? (
        <PanelSection title={phase === "none" ? "Locked" : "Session locked"}>
          <PanelSectionRow>
            <div style={{ padding: "4px 0" }}>
              {phase === "pending"
                ? "Session is armed. Play is still allowed until it starts. You cannot cancel."
                : phase === "active"
                  ? "Session is active — games are blocked. Wait for it to end; there is no unlock."
                  : "Settings are frozen until the commitment ends. No in-plugin disable."}
            </div>
          </PanelSectionRow>
        </PanelSection>
      ) : (
        <>
          <PanelSection title="Start session">
            <PanelSectionRow>
              <div style={{ padding: "4px 0", opacity: 0.85 }}>
                Block all games for a period. Start now, or after a delay
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
                In 1 min · then 5 min
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
                label="Start after (minutes, 0 = now)"
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
      )}

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
