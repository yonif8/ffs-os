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
import { OS_DONE_PRESET } from "./sound";

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
  /**
   * The firmware's OWN swirl animation — a real firmware-level visual, rendered by the glasses
   * with no pixels from the phone. It runs on the even_ai service rather than EvenHub, which is
   * why it is a host capability rather than something the Session can express.
   *
   * ⚠️ It OWNS the display while it runs: it replaces whatever page is declared, and turning it
   * off leaves the HUD empty until something re-declares. Callers must restore their own screen.
   */
  setSwirl(on: boolean): Promise<void> | void;
  /**
   * Play one of the firmware's canned sounds. Presets only, by design: they self-terminate in
   * the driver, so a dropped link cannot leave the piezo sounding.
   */
  playPreset(preset: number): Promise<void> | void;
  /** Wall clock, injected so screens are deterministic in tests. */
  now(): Date;
  /** Optional note source. The glasses cannot capture text, so this is read-only by nature. */
  readNotes?(): string[];
}

/** In-memory OS state. Persisted by the host if it wants to. */
export interface OsState {
  brightness: number;
  silent: boolean;
  wearDetect: boolean;
  /**
   * Whether the OS may make a sound. OFF by default, and deliberately so: the glasses live on
   * someone's face or beside their bed, and a timer that chimes unasked is worse than one that
   * does not. The user turns this on in Settings.
   */
  sound: boolean;
}

const rows = <V>(items: Array<[string, V]>): Row<V>[] =>
  items.map(([label, value]) => ({ label, value }));

/** Two-space padding reads better on the HUD than a colon at this glyph size. */
const kv = (k: string, v: string) => `${k}  ${v}`;

export class FfsOs {
  readonly state: OsState = { brightness: 15, silent: false, wearDetect: true, sound: false };

  constructor(private readonly session: Session, private readonly host: OsHost) {}

  /** Boot the OS. Returns when the user backs out of the home screen. */
  async run(): Promise<void> {
    await this.home();
  }

  // ---- home ---------------------------------------------------------------------------------

  private async home(): Promise<void> {
    await this.session.menu<string>(
      {
        header: "FFS OS",
        rows: rows([
          ["Clock", "clock"],
          ["Settings", "settings"],
          ["Device", "device"],
          ["Visuals", "visuals"],
          ["Apps", "apps"],
        ]),
      },
      async (sel: Selection<string>) => {
        switch (sel.value) {
          case "clock": return this.clock();
          case "settings": return this.settings();
          case "device": return this.device();
          case "visuals": return this.visuals();
          case "apps": return this.apps();
        }
      }
    );
  }

  // ---- clock --------------------------------------------------------------------------------

  /**
   * A LIVE clock: the time sits in the header and is updated in place once a second.
   *
   * Deliberately not done with a page rebuild. A rebuild re-declares the list and sends its
   * focus back to row 0, so a ticking rebuild would fight the user every second they tried to
   * scroll. `setHeaderText` changes one container's bytes and leaves the list untouched, which
   * is the whole reason text.updateInPlace was worth proving.
   */
  private async clock(): Promise<void> {
    const stamp = () => {
      const t = this.host.now();
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      const ss = String(t.getSeconds()).padStart(2, "0");
      return `${hh}:${mm}:${ss}`;
    };
    const t = this.host.now();
    const day = t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

    const screen = await this.session.push<string>({
      header: stamp(),
      rows: rows([[day, "d"], ["Back", "back"]]),
    });

    // Tick until the user leaves. Errors are swallowed on purpose: a dropped link mid-tick must
    // not take the whole OS down, and the reconnect path will re-declare the screen anyway.
    const timer = setInterval(() => {
      void screen.setHeaderText(stamp()).catch(() => {});
    }, 1000);
    try {
      await screen.nextSelection();
    } finally {
      clearInterval(timer);
      await this.session.pop();
    }
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
        header: "Settings",
        rows: rows([
          [kv("Brightness", String(this.state.brightness)), "brightness"],
          [kv("Silent", this.state.silent ? "On" : "Off"), "silent"],
          [kv("Wear detect", this.state.wearDetect ? "On" : "Off"), "wear"],
          [kv("Sound", this.state.sound ? "On" : "Off"), "sound"],
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
          case "sound":
            this.state.sound = !this.state.sound;
            // Confirm audibly ONLY when switching ON — turning sound off must be silent.
            if (this.state.sound) await this.host.playPreset(OS_DONE_PRESET);
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
        header: "Brightness",
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
        header: "Device",
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

  // ---- visuals — firmware-level animation, no pixels from the phone -------------------------

  private async visuals(): Promise<void> {
    await this.session.menu<string>(
      { header: "Visuals", rows: rows([["Swirl", "swirl"], ["Stop", "stop"]]) },
      async (sel) => {
        await this.host.setSwirl(sel.value === "swirl");
        // The swirl takes the display over, so coming back means re-declaring this screen.
        // menu() already restores after a handler returns — that shared restore path is exactly
        // what makes this a one-liner instead of a special case.
      }
    );
  }

  // ---- apps ---------------------------------------------------------------------------------

  private async apps(): Promise<void> {
    await this.session.menu<string>(
      { header: "Apps", rows: rows([["Timer", "timer"], ["Notes", "notes"], ["About", "about"]]) },
      async (sel) => {
        switch (sel.value) {
          case "timer": return this.timer();
          case "notes": return this.notes();
          case "about": return this.about();
        }
      }
    );
  }

  /**
   * A countdown timer.
   *
   * Built on the same in-place header update as the clock, for the same reason: a page rebuild
   * every second would drag the list's focus back to row 0 and make the running screen unusable.
   * The timer therefore counts down in the header while the rows stay live and selectable.
   *
   * No audible alert — the buzzer is Tier 2 and has never been sounded. The timer says DONE and
   * stops, which is honest about what the hardware has been proven to do.
   */
  private async timer(): Promise<void> {
    const durations: Array<[string, number]> = [
      ["1 min", 60],
      ["3 min", 180],
      ["5 min", 300],
      ["10 min", 600],
    ];
    await this.session.menu<number>(
      { header: "Timer", rows: durations.map(([label, value]) => ({ label, value })) },
      async (sel) => this.runTimer(sel.value ?? 60)
    );
  }

  private async runTimer(seconds: number): Promise<void> {
    const started = this.host.now().getTime();
    const fmt = (left: number) => {
      const m = Math.floor(Math.max(0, left) / 60);
      const s = Math.max(0, left) % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    const screen = await this.session.push<string>({
      header: fmt(seconds),
      rows: rows([["Running", "r"], ["Back to stop", "back"]]),
    });

    const timer = setInterval(() => {
      const elapsed = Math.floor((this.host.now().getTime() - started) / 1000);
      const left = seconds - elapsed;
      void screen.setHeaderText(left <= 0 ? "DONE" : fmt(left)).catch(() => {});
      if (left <= 0) {
        clearInterval(timer);
        if (this.state.sound) void Promise.resolve(this.host.playPreset(OS_DONE_PRESET)).catch(() => {});
      }
    }, 1000);

    try {
      await screen.nextSelection();
    } finally {
      clearInterval(timer);
      await this.session.pop();
    }
  }

  /**
   * Notes — read-only for now, and deliberately so.
   *
   * The glasses have no text entry: the whole input vocabulary is scroll, tap and double-tap.
   * Anything that claimed to CAPTURE a note would have to invent an input method that does not
   * exist, so this shows notes the host supplies and nothing more.
   */
  private async notes(): Promise<void> {
    const notes = this.host.readNotes?.() ?? [];
    await this.session.menu<string>(
      {
        header: "Notes",
        rows: notes.length
          ? notes.map((n) => ({ label: n, value: n }))
          : rows([["(no notes)", "none"]]),
      },
      async () => { /* read-only */ }
    );
  }

  private async about(): Promise<void> {
    await this.session.menu<string>(
      {
        header: "About",
        rows: rows([
          ["FFS OS 0.1", "a"],
          ["Built on the FFS SDK", "b"],
          ["Even Realities G2", "c"],
        ]),
      },
      async () => {}
    );
  }
}
