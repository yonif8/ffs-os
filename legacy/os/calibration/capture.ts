//
// SDK Calibration Harness — the capture engine (FUT-236).
//
// Subscribes to EVERY inbound channel and files each record under whichever step is
// active at the moment it arrives. That labelling is the entire value of this harness:
// on 2026-07-28 a ring byte-stream was decoded but could not be attributed to gestures,
// because nothing recorded what the human was doing while the bytes came in.
//
// Deliberately records MORE than it interprets. Frames our parser doesn't understand
// are the interesting ones — the ring's real protocol matched none of our documented
// framing, and we only learned that because raw hex was kept.
//

import FfsBle from "../../../modules/ffs-ble";
import type { EventSubscription } from "expo-modules-core";
import { glog } from "../log";

/** One captured record, always tagged with the step that was active. */
export interface CaptureRecord {
  /** Milliseconds since the run started — comparable across sources. */
  t: number;
  /** Wall clock, so the artifact can be lined up against server-side logs. */
  wall: number;
  /** Which step was on screen. This is the label. */
  step: string;
  /** Which channel produced it. */
  source:
    | "ringRaw"
    | "ringConnected"
    | "ringDisconnected"
    | "ringBattery"
    | "gesture"
    | "notify"
    | "deviceFound"
    | "connected"
    | "disconnected"
    | "servicesDiscovered"
    | "deviceInfo"
    | "state"
    | "log"
    | "marker";
  /** Raw payload, verbatim. */
  data: Record<string, unknown>;
}

export interface CaptureSummary {
  startedAt: number;
  endedAt: number | null;
  appVersion: string;
  records: CaptureRecord[];
  /** Per-step counts, so a run's health is visible without parsing everything. */
  perStep: Record<string, number>;
}

export class Capture {
  private subs: EventSubscription[] = [];
  private records: CaptureRecord[] = [];
  private step = "(none)";
  private t0 = Date.now();
  private appVersion: string;
  /** Fired on every record so the UI can show a live counter — proof capture is alive. */
  onRecord?: (r: CaptureRecord, total: number) => void;

  constructor(appVersion: string) {
    this.appVersion = appVersion;
  }

  /** Set the active label. Every subsequent record is filed under it. */
  setStep(id: string): void {
    this.step = id;
    this.push("marker", { marker: "step.enter", step: id });
  }

  markExit(id: string, note?: string): void {
    this.push("marker", { marker: "step.exit", step: id, note });
  }

  /** Free-form annotation from the runner (e.g. "human tapped Done"). */
  note(note: string, extra?: Record<string, unknown>): void {
    this.push("marker", { marker: "note", note, ...extra });
  }

  private push(source: CaptureRecord["source"], data: Record<string, unknown>): void {
    const r: CaptureRecord = {
      t: Date.now() - this.t0,
      wall: Date.now(),
      step: this.step,
      source,
      data,
    };
    this.records.push(r);
    // Stream to the collector as we go. If the run is abandoned halfway — phone dies,
    // app killed, human gives up — everything captured up to that point still survives.
    glog.emit("calib", "record", r as unknown as Record<string, unknown>);
    this.onRecord?.(r, this.records.length);
  }

  start(): void {
    this.t0 = Date.now();
    this.records = [];
    glog.emit("calib", "run_start", { appVersion: this.appVersion, at: this.t0 });

    this.subs = [
      // ---- ring, phone link ----
      FfsBle.addListener("onRingRaw", (p) => this.push("ringRaw", { ...p })),
      FfsBle.addListener("onRingConnected", (p) => this.push("ringConnected", { ...p })),
      FfsBle.addListener("onRingDisconnected", (p) => this.push("ringDisconnected", { ...p })),
      FfsBle.addListener("onRingBattery", (p) => this.push("ringBattery", { ...p })),

      // ---- gestures, either device. `source`/`device` are what make attribution possible.
      FfsBle.addListener("onGesture", (p) => this.push("gesture", { ...p })),

      // ---- glasses link ----
      FfsBle.addListener("onDeviceFound", (p) => this.push("deviceFound", { ...p })),
      FfsBle.addListener("onConnected", (p) => this.push("connected", { ...p })),
      FfsBle.addListener("onDisconnected", (p) => this.push("disconnected", { ...p })),
      FfsBle.addListener("onServicesDiscovered", (p) => this.push("servicesDiscovered", { ...p })),
      FfsBle.addListener("onDeviceInfo", (p) => this.push("deviceInfo", { ...p })),
      FfsBle.addListener("onNotify", (p) => this.push("notify", { ...p })),
      FfsBle.addListener("onStateChange", (p) => this.push("state", { ...p })),

      // Native driver log lines. Verbose, and worth it: the driver often knows exactly
      // why something didn't happen ("Bluetooth is not powered on") while the UI shows
      // nothing at all.
      FfsBle.addListener("onLog", (p) => this.push("log", { ...p })),
    ];
  }

  stop(): CaptureSummary {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    const summary = this.summary();
    glog.emit("calib", "run_end", {
      endedAt: Date.now(),
      total: summary.records.length,
      perStep: summary.perStep,
    });
    return summary;
  }

  summary(): CaptureSummary {
    const perStep: Record<string, number> = {};
    for (const r of this.records) perStep[r.step] = (perStep[r.step] ?? 0) + 1;
    return {
      startedAt: this.t0,
      endedAt: null,
      appVersion: this.appVersion,
      records: this.records,
      perStep,
    };
  }

  get count(): number {
    return this.records.length;
  }

  /** Records captured during a given step — used for the on-screen per-step tally. */
  countFor(stepId: string): number {
    let n = 0;
    for (const r of this.records) if (r.step === stepId && r.source !== "marker") n++;
    return n;
  }
}
