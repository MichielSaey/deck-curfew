import { callable } from "@decky/api";
import type { CurfewStatus } from "./types";

export const getStatus = callable<[], CurfewStatus>("get_status");
export const updateSchedule = callable<[patch: Record<string, unknown>], CurfewStatus>(
  "update_schedule"
);
export const lockCurfew = callable<[untilIso: string], CurfewStatus>("lock_curfew");
export const lockPreset = callable<[preset: string], CurfewStatus>("lock_preset");
