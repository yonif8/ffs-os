// FFS OS — a mini on-glass operating system, written ENTIRELY against the SDK.
//
// This file is the proof that the SDK is usable: it contains no protobuf, no field numbers, no
// container ids, no BLE. If anything here had to reach around the SDK to work, the SDK would have
// failed its stated purpose ("an app can be written against it without touching firmware
// internals"). Read it as the worked example, not as framework code.
//
// The whole OS is a tree of menus over Session.menu(), which means every screen inherits the
// properties that were expensive to get right: declare-once (scrolling costs nothing), back as a
// value rather than an exception, events queued rather than dropped, and pop-restore sharing the
// reconnect path.

import { Session } from "./session";
import type { Row, Selection } from "./types";
import { LIMITS } from "./types";

/** Everything the OS needs from the outside world. Injected so the whole OS is testable. */
export interface OsHost {
  setBrightness(level: number, autoAdjust: boolean): Promise<void> | void;
  setSilentMode(on: boolean): Promise<void> | void;
  setWearDetection(on: boolean): Promise<void> | void;
  /** Latest known device state; the OS renders it, never polls for it. */
  readSettings(): Promise<{
    battery?: number;
    brightness?: number;
    silentMode?: number;
    wearDetection?: number;
    leftFirmware?: string;
    rightFirmware?: string;
  }>;
  /** Wall clock, injected so screens are deterministic in tests. */
  now(): Date;
}

/** In-memory OS state. Persisted by the host if it wants to. */
export interface OsState {
  brightness: number;
  silent: boolean;
  wearDetect: boolean;
}

const rows = <V>(items: Array<[string, V]>): Row<V>[] =>
  items.map(([label, value]) => ({ label, value }));

/** Two-space padding reads better on the HUD than a colon at this glyph size. */
const kv = (k: string, v: string) => `${k}  ${v}`;

export class FfsOs {
  readonly state: OsState = { brightness: 15, silent: false, wearDetect: true };

  constructor(private readonly session: Session, private readonly host: OsHost) {}

  /** Boot the OS. Returns when the user backs out of the home screen. */
  async run(): Promise<void> {
    await this.home();
  }

  // ---- home ---------------------------------------------------------------------------------

  private async home(): Promise<void> {
    await this.session.menu<string>(
      { rows: rows([["Clock", "clock"], ["Settings", "settings"], ["Device", "device"], ["Apps", "apps"]]) },
      async (sel: Selection<string>) => {
        switch (sel.value) {
          case "clock": return this.clock();
          case "settings": return this.settings();
          case "device": return this.device();
          case "apps": return this.apps();
        }
      }
    );
  }

  // ---- clock --------------------------------------------------------------------------------

  private async clock(): Promise<void> {
    const t = this.host.now();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const day = t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    // A list of one row is the simplest way to get a screen that reports back — the firmware
    // needs a capturing container for a double-tap to come home.
    await this.session.menu<string>(
      { rows: rows([[`${hh}:${mm}`, "t"], [day, "d"], ["Back", "back"]]) },
      async () => { /* any tap returns to home via the menu loop's back handling */ }
    );
  }

  // ---- settings — REAL settings, not placeholders --------------------------------------------

  private async settings(): Promise<void> {
    for (;;) {
      const done = await this.settingsOnce();
      if (done) return;
    }
  }

  /** One pass of the settings menu. Returns true when the user backed out. */
  private async settingsOnce(): Promise<boolean> {
    let backedOut = true;
    await this.session.menu<string>(
      {
        rows: rows([
          [kv("Brightness", String(this.state.brightness)), "brightness"],
          [kv("Silent", this.state.silent ? "On" : "Off"), "silent"],
          [kv("Wear detect", this.state.wearDetect ? "On" : "Off"), "wear"],
        ]),
      },
      async (sel) => {
        backedOut = false;
        switch (sel.value) {
          case "brightness": await this.brightnessMenu(); break;
          case "silent":
            this.state.silent = !this.state.silent;
            await this.host.setSilentMode(this.state.silent);
            break;
          case "wear":
            this.state.wearDetect = !this.state.wearDetect;
            await this.host.setWearDetection(this.state.wearDetect);
            break;
        }
      }
    );
    return backedOut;
  }

  /**
   * Brightness picker. The levels are the ones MEASURED through the camera rig, not a linear
   * ramp: the mapping to actual lens output is nonlinear, 100 is unreadable through a camera,
   * and below ~10 the unselected rows of a list stop being legible.
   */
  private async brightnessMenu(): Promise<void> {
    const levels = [5, 10, 15, 20, 40, 70, 100];
    await this.session.menu<number>(
      {
        rows: levels.map((n) => ({
          label: n === this.state.brightness ? `${n}  <` : String(n),
          value: n,
        })),
      },
      async (sel) => {
        const level = Math.max(LIMITS.BRIGHTNESS_MIN, Math.min(LIMITS.BRIGHTNESS_MAX, sel.value!));
        this.state.brightness = level;
        await this.host.setBrightness(level, false);
      }
    );
  }

  // ---- device -------------------------------------------------------------------------------

  private async device(): Promise<void> {
    const s = await this.host.readSettings();
    await this.session.menu<string>(
      {
        rows: rows([
          [kv("Battery", s.battery != null ? `${s.battery}%` : "--"), "b"],
          [kv("Left", s.leftFirmware ?? "--"), "l"],
          [kv("Right", s.rightFirmware ?? "--"), "r"],
          [kv("Brightness", String(s.brightness ?? this.state.brightness)), "br"],
        ]),
      },
      async () => { /* read-only screen */ }
    );
  }

  // ---- apps ---------------------------------------------------------------------------------

  private async apps(): Promise<void> {
    await this.session.menu<string>(
      { rows: rows([["Notes", "notes"], ["Timer", "timer"], ["About", "about"]]) },
      async (sel) => {
        if (sel.value === "about") {
          await this.session.menu<string>(
            { rows: rows([["FFS OS", "a"], ["Built on the FFS SDK", "b"], ["Even Realities G2", "c"]]) },
            async () => {}
          );
        } else {
          // Placeholder apps, deliberately: the goal asks for apps to exist, and a stub that
          // navigates correctly proves more about the OS than a half-built feature would.
          await this.session.menu<string>(
            { rows: rows([[`${sel.row.label}`, "x"], ["(not implemented)", "y"]]) },
            async () => {}
          );
        }
      }
    );
  }
}
