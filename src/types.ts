export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type TimeWindow = {
  start: string;
  end: string;
};

export type SessionPhase = "none" | "pending" | "active";

export type CurfewSettings = {
  lockedUntil: string | null;
  sessionStartsAt: string | null;
  timezone: string;
  mode: "block_after" | "allow_windows";
  warnMinutes: number;
  blockAction: "terminate";
  blockAfter: string;
  weekendBlockAfter: string;
  days: Record<DayKey, TimeWindow[]>;
};

export type CurfewStatus = {
  now: string;
  locked: boolean;
  lockedUntil: string | null;
  sessionStartsAt: string | null;
  sessionPhase: SessionPhase;
  playAllowed: boolean;
  shouldBlockPlay: boolean;
  blockAction: "terminate";
  warnMinutes: number;
  minutesToCutoff: number | null;
  shouldWarn: boolean;
  cutoffAt: string | null;
  allowAt: string | null;
  statusLine: string;
  lockLine: string | null;
  settings: CurfewSettings;
};
