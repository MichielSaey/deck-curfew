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
import { getStatus, lockPreset, updateSchedule } from "./api";
import { applyStatus } from "./enforce";
import type { CurfewStatus } from "./types";

function isHhMm(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

export function Content() {
  const [status, setStatus] = useState<CurfewStatus | null>(null);
  const [blockAfter, setBlockAfter] = useState("21:00");
  const [weekendBlockAfter, setWeekendBlockAfter] = useState("22:00");
  const [warnMinutes, setWarnMinutes] = useState("5");
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
    const id = setInterval(() => void refresh(), 15000);
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

  const confirmLock = (preset: string, label: string) => {
    showModal(
      <ConfirmModal
        strTitle="Lock Deck Curfew?"
        strDescription={`Once locked, you cannot change the schedule or turn curfew off until ${label}. There is no unlock button — like Freedom.`}
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
        <PanelSection title="Locked">
          <PanelSectionRow>
            <div style={{ padding: "4px 0" }}>
              Settings are frozen until the commitment ends. There is no way to disable
              curfew from this plugin while locked.
            </div>
          </PanelSectionRow>
        </PanelSection>
      ) : (
        <>
          <PanelSection title="Schedule">
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

          <PanelSection title="Lock curfew">
            <PanelSectionRow>
              <div style={{ padding: "4px 0", opacity: 0.85 }}>
                Locking turns enforcement on. You cannot unlock early from the UI.
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
            Hard-quits games outside your play window. Escape hatches outside this plugin
            still exist (uninstall Decky plugin / Desktop Mode) — this matches Freedom’s
            commitment model on an open device, not parental TPM lockdown.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}
