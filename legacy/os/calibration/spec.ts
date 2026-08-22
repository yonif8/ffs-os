//
// SDK Calibration Harness — the step script (FUT-236).
//
// Yoni, 2026-07-28: "Create a calibration process I can go through that will give
// you all this data… tell me exactly what to do… captures everything… make this
// extensive and include everything you need to progress the SDK dev."
//
// WHY THIS FILE IS JUST DATA
// Every step is a declaration, not code, so the whole experiment is readable in one
// screen and adding a question later is a three-line diff. The runner
// (CalibrationScreen.tsx) knows how to execute any step of these kinds; it knows
// nothing about rings or gestures.
//
// THE ONE IDEA THAT MATTERS: LABELLED WINDOWS.
// Every frame captured while a step is active is tagged with that step's id. Today's
// session decoded a ring stream it could not attribute, because nothing recorded what
// the human was doing while the bytes arrived — so the analysis had to guess. Here the
// label is recorded at capture time and attribution is free.
//

/** What the runner should do while a step is on screen. */
export type StepKind =
  /** Show instructions; advance only when the human taps Done. */
  | "manual"
  /** Run an action, then advance automatically once `until` is satisfied (or timeout). */
  | "auto"
  /** Capture for a fixed duration with a visible countdown, then advance. */
  | "timed";

export interface CalibrationStep {
  /** Stable id — this is the label every captured frame carries. Never renumber. */
  id: string;
  /** Section heading, for the progress display. */
  section: string;
  /** Short imperative title. */
  title: string;
  /** What the human should physically do. Plain language — no jargon, no UUIDs. */
  instruction: string;
  kind: StepKind;
  /** For "timed": how long to capture. */
  seconds?: number;
  /** For "auto": which side-effect to fire on entry. */
  action?:
    | "checkBluetooth"
    | "scanAll"
    | "connectGlasses"
    | "readDeviceInfo"
    | "connectRing"
    | "ringAdvStart"
    | "ringForget";
  /**
   * How many times to repeat the gesture. Shown as a counter so the human knows when
   * they're done — repeats matter because a single sample cannot separate a constant
   * from a coincidence.
   */
  reps?: number;
  /**
   * WHAT THIS STEP IS FOR — surfaced in the artifact next to the data it produced, so
   * a future reader (or a future me) knows what question the bytes were meant to answer.
   */
  answers: string;
}

/**
 * The run. Order matters: environment → profiles → idle baseline → labelled gestures
 * → cross-path. The baseline comes BEFORE any gesture so periodic chatter can be
 * subtracted from everything that follows.
 */
export const CALIBRATION_STEPS: CalibrationStep[] = [
  // ── A. Environment ────────────────────────────────────────────────────────
  {
    id: "env.bluetooth",
    section: "Setup",
    title: "Bluetooth check",
    instruction:
      "Make sure Bluetooth is ON. If it's off, nothing else in this run can work — turn it on now and this step will clear itself.",
    kind: "auto",
    action: "checkBluetooth",
    answers: "Blocks the run rather than producing a confusing empty capture (this cost ten minutes on 2026-07-28).",
  },
  {
    id: "env.scan",
    section: "Setup",
    title: "Discover everything nearby",
    instruction:
      "Put the ring on and hold the glasses nearby. Keep both UNPAIRED from the Even app. Just wait — this listens for about 20 seconds.",
    kind: "timed",
    seconds: 20,
    action: "scanAll",
    answers:
      "Full advertisement records: names, RSSI, manufacturer data (where the ring's MAC lives — never captured before), advertised services.",
  },

  // ── B. Device profiles ───────────────────────────────────────────────────
  {
    id: "profile.glasses",
    section: "Profiles",
    title: "Connect the glasses",
    instruction: "Put the glasses on or keep them close. Wait for both lenses to connect.",
    kind: "auto",
    action: "connectGlasses",
    answers:
      "Complete service + characteristic dump for BOTH lenses with properties. We have only ever looked up UUIDs we already knew.",
  },
  {
    id: "profile.deviceinfo",
    section: "Profiles",
    title: "Read glasses info",
    instruction: "Nothing to do — reading firmware version, battery and serial.",
    kind: "auto",
    action: "readDeviceInfo",
    answers: "Firmware version per lens, battery, serial — pins the build every later claim refers to.",
  },
  {
    id: "profile.ring",
    section: "Profiles",
    title: "Connect the ring",
    instruction: "Keep wearing the ring. Accept any pairing prompt iOS shows.",
    kind: "auto",
    action: "connectRing",
    answers: "The ring's own service/characteristic profile, and which notify channels actually emit.",
  },

  // ── C. Baseline ──────────────────────────────────────────────────────────
  {
    id: "baseline.idle",
    section: "Baseline",
    title: "Do nothing for 30 seconds",
    instruction:
      "IMPORTANT: don't touch the ring, the glasses or the phone. Rest your hand. This records what the devices say when nobody is doing anything.",
    kind: "timed",
    seconds: 30,
    answers:
      "Separates periodic status chatter from real input. Without this, every later analysis has to GUESS which frames are noise.",
  },

  // ── D. Labelled gestures ─────────────────────────────────────────────────
  {
    id: "gesture.tap",
    section: "Ring gestures",
    title: "Single tap ×5",
    instruction: "Tap the ring's touch surface ONCE. Pause ~2 seconds. Do that 5 times.",
    kind: "manual",
    reps: 5,
    answers: "Which type code is a single tap — on the ring link AND the glasses link.",
  },
  {
    id: "gesture.doubletap",
    section: "Ring gestures",
    title: "Double tap ×5",
    instruction: "Tap TWICE quickly. Pause ~2 seconds. Do that 5 times.",
    kind: "manual",
    reps: 5,
    answers: "Whether double-tap is its own code or two taps the app must coalesce.",
  },
  {
    id: "gesture.hold",
    section: "Ring gestures",
    title: "Hold ×3",
    instruction: "Press and HOLD for about a second, then release. Pause. Do that 3 times.",
    kind: "manual",
    reps: 3,
    answers:
      "Whether hold reaches the phone at all — it has NEVER been observed, and we don't know if that's the ring or us.",
  },
  {
    id: "gesture.swipeup",
    section: "Ring gestures",
    title: "Swipe up ×5",
    instruction: "Swipe along the ring away from your palm. Normal speed. Pause between each. 5 times.",
    kind: "manual",
    reps: 5,
    answers: "The up direction's type code and its data range.",
  },
  {
    id: "gesture.swipedown",
    section: "Ring gestures",
    title: "Swipe down ×5",
    instruction: "Swipe the other way, toward your palm. Normal speed. Pause between each. 5 times.",
    kind: "manual",
    reps: 5,
    answers: "The down direction's code — and whether direction is a code or a sign in the data.",
  },
  {
    id: "gesture.swipe.slow",
    section: "Speed vs distance",
    title: "Swipe SLOWLY ×3",
    instruction: "Swipe up as SLOWLY as you can — take a full second per swipe. 3 times.",
    kind: "manual",
    reps: 3,
    answers:
      "Half of the velocity-vs-distance question: same distance, different speed. The ring streams magnitude values and we do not yet know what they measure.",
  },
  {
    id: "gesture.swipe.fast",
    section: "Speed vs distance",
    title: "Swipe FAST ×3",
    instruction: "Now swipe up as FAST as you can — a flick. Same length of swipe. 3 times.",
    kind: "manual",
    reps: 3,
    answers: "The other half: if the numbers change but the distance didn't, they're velocity.",
  },
  {
    id: "gesture.swipe.short",
    section: "Speed vs distance",
    title: "Short swipes ×3",
    instruction: "Swipe up a SHORT distance — barely move your finger. Normal speed. 3 times.",
    kind: "manual",
    reps: 3,
    answers: "Distance control: same speed, shorter travel.",
  },
  {
    id: "gesture.swipe.long",
    section: "Speed vs distance",
    title: "Long swipes ×3",
    instruction: "Swipe up the FULL length of the touch surface. Normal speed. 3 times.",
    kind: "manual",
    reps: 3,
    answers:
      "Completes the 2x2. Together these four steps settle whether proportional scrolling is possible and what to scale it by.",
  },

  // ── E. Attribution + cross-path ──────────────────────────────────────────
  {
    id: "temple.tap",
    section: "Attribution",
    title: "Tap the GLASSES temple ×3",
    instruction:
      "Leave the ring alone. Tap the touchpad on the right arm of the glasses. 3 times, pausing between.",
    kind: "manual",
    reps: 3,
    answers:
      "The temples' own source marker. Without it, ring-vs-temple attribution is an assumption — and swipes carry no source field at all.",
  },
  {
    id: "temple.swipe",
    section: "Attribution",
    title: "Swipe the GLASSES temple ×3",
    instruction: "Still not the ring — swipe forward along the glasses arm. 3 times.",
    kind: "manual",
    reps: 3,
    answers:
      "Whether a temple swipe is distinguishable from a ring swipe. If it isn't, that's a permanent OS design constraint, not a bug.",
  },
  {
    id: "cross.advstart",
    section: "Cross-path",
    title: "Tell the ring to hold both links",
    instruction: "Nothing to do — sending the command, then do a few taps and swipes when prompted.",
    kind: "auto",
    action: "ringAdvStart",
    answers: "Whether the ring keeps its phone link while also serving the glasses.",
  },
  {
    id: "cross.both",
    section: "Cross-path",
    title: "Mixed gestures ×6",
    instruction: "Do any mix of taps and swipes on the RING — about 6 of them, at your own pace.",
    kind: "manual",
    reps: 6,
    answers:
      "Correlates the two paths on one timeline: which ring frame produced which glasses gesture, and the latency between them.",
  },
  {
    id: "cross.glassesoff",
    section: "Cross-path",
    title: "Turn the glasses OFF",
    instruction:
      "Power the glasses off completely. Wait for them to disconnect, then do 5 taps and swipes on the ring.",
    kind: "manual",
    reps: 5,
    answers:
      "The biggest surprise of 2026-07-28: the ring's phone link only started streaming once the glasses connected. Is that sticky, or does it stop again?",
  },
];

/** Total steps, for the progress indicator. */
export const STEP_COUNT = CALIBRATION_STEPS.length;
