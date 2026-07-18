// FFS Glasses OS — on-glass "phone OS" navigation engine (FUT-163).
//
// A tiny stateful controller that turns G2 touchpad gestures into navigation through a
// tree of screens rendered on the 576x288 HUD, deliberately shaped like a stock phone OS
// (status bar + app menu + nested screens). It's the interactive test surface for the
// whole driver: every list re-render exercises showText, the Camera screen exercises the
// P4 image path, and the whole thing is driven purely by gestures.
//
// GESTURE MODEL (confirmed with Yoni):
//   swipe_up   → move selection up (previous item)
//   swipe_down → move selection down (next item)
//   tap        → open / activate the selected item
//   double_tap → back to the previous screen
//
// The controller owns a navigation STACK (each frame = a screen + its selection index).
// It only repaints when something actually changed, so a no-op gesture (e.g. a swipe on a
// text screen, or a tap on the image screen) never re-sends a heavy frame to the glasses.

import FfsBle, { type G2GestureName } from "../../../modules/ffs-ble";

export type ScreenKind = "list" | "text" | "image" | "anim" | "stockdash";

/** Live context the dynamic screens read at paint time (connection, version, etc.). */
export interface PhoneCtx {
  pairReady: () => boolean;
  sides: () => { L: boolean; R: boolean };
  battery: () => number;
  version: () => string;
  gestures: () => number;
}

export interface MenuItem {
  label: string;
  /** Right-side hint, e.g. ">", "On", "3". */
  hint?: string;
  /** Screen to push on tap. */
  target?: Screen;
  /** Side-effect to fire on tap (e.g. FfsBle.showImage for a "shutter"). */
  action?: () => void;
}

export interface Screen {
  id: string;
  title: string;
  kind: ScreenKind;
  /** For `list` screens: the rows. */
  items?: MenuItem[];
  /** For `text` screens: dynamic body lines (rendered under the title). */
  body?: (ctx: PhoneCtx) => string[];
  /** For `anim` screens: the animation id passed to FfsBle.playAnimation (FUT-165). */
  animId?: string;
}

// HUD ~= 7 text rows at the default font. Reserve row 1 (status bar) + row 2 (title);
// that leaves 5 content rows for the list window / text body.
const MAX_ROWS = 5;

interface Frame {
  screen: Screen;
  sel: number;
}

export class PhoneNav {
  private stack: Frame[];
  private ctx: PhoneCtx;
  private onChange: () => void;
  gestureCount = 0;

  constructor(root: Screen, ctx: PhoneCtx, onChange: () => void) {
    this.stack = [{ screen: root, sel: 0 }];
    this.ctx = ctx;
    this.onChange = onChange;
  }

  private top(): Frame {
    return this.stack[this.stack.length - 1];
  }

  /** True while the current screen renders the image path (so callers can skip text repaints). */
  onImageScreen(): boolean {
    return this.top().screen.kind === "image";
  }

  /** True while the current screen OWNS the HUD surface (image OR live animation) — text
   *  repaints (e.g. the minute clock) must be suppressed so they don't clobber it. */
  ownsHudSurface(): boolean {
    const k = this.top().screen.kind;
    // "stockdash" releases our page to the firmware's native dashboard — a text repaint
    // would re-grab the HUD and hide it, so treat it as surface-owning too (FUT-170).
    return k === "image" || k === "anim" || k === "stockdash";
  }

  /** Route a gesture into navigation. Repaints only if state actually changed. */
  handleGesture(name: G2GestureName): void {
    this.gestureCount++;
    const cur = this.top();
    const items = cur.screen.items ?? [];
    let changed = false;

    switch (name) {
      case "swipe_up":
        if (items.length > 1) {
          cur.sel = (cur.sel - 1 + items.length) % items.length;
          changed = true;
        }
        break;
      case "swipe_down":
        if (items.length > 1) {
          cur.sel = (cur.sel + 1) % items.length;
          changed = true;
        }
        break;
      case "tap":
        changed = this.activate();
        break;
      case "double_tap":
        changed = this.back();
        break;
    }

    if (changed) this.onChange();
  }

  private activate(): boolean {
    const cur = this.top();
    const item = (cur.screen.items ?? [])[cur.sel];
    if (!item) return false;
    let changed = false;
    if (item.action) {
      item.action();
      changed = true;
    }
    if (item.target) {
      this.stack.push({ screen: item.target, sel: 0 });
      changed = true;
    }
    return changed;
  }

  /** Pop one screen. Returns whether anything changed. */
  back(): boolean {
    if (this.stack.length > 1) {
      if (this.top().screen.kind === "anim") FfsBle.stopAnimation();
      this.stack.pop();
      return true;
    }
    return false;
  }

  /** Jump straight to the root home screen. */
  goHome(): void {
    if (this.top().screen.kind === "anim") FfsBle.stopAnimation();
    this.stack = [{ screen: this.stack[0].screen, sel: 0 }];
    this.onChange();
  }

  /** Paint the current screen to the HUD (image screens use the raw-image path). */
  async paint(): Promise<void> {
    const screen = this.top().screen;
    if (screen.kind === "image") {
      FfsBle.showImage();
      return;
    }
    if (screen.kind === "anim") {
      // Start streaming pixel frames to the HUD (FUT-165). showText/showImage on the driver
      // side auto-stop this loop, and back()/goHome() call stopAnimation explicitly.
      if (screen.animId) FfsBle.playAnimation(screen.animId);
      return;
    }
    if (screen.kind === "stockdash") {
      // Release our page so Even's OWN native dashboard shows (FUT-170). A back/goHome to a
      // text screen re-creates our page (the way out); we never paint text over it here.
      FfsBle.showStockDashboard();
      return;
    }
    FfsBle.showText(this.renderText().join("\n"));
  }

  /** Compose the current text screen: status bar + title + list window / body. */
  renderText(): string[] {
    const cur = this.top();
    const lines: string[] = [this.statusBar()];

    const crumb = this.stack.length > 1 ? "‹ " : "";
    lines.push(`${crumb}${cur.screen.title}`);

    if (cur.screen.items && cur.screen.items.length) {
      const items = cur.screen.items;
      let start = 0;
      if (items.length > MAX_ROWS) {
        start = Math.min(
          Math.max(cur.sel - Math.floor(MAX_ROWS / 2), 0),
          items.length - MAX_ROWS,
        );
      }
      const win = items.slice(start, start + MAX_ROWS);
      win.forEach((it, i) => {
        const idx = start + i;
        const marker = idx === cur.sel ? ">" : " ";
        const hint = it.hint ? `   ${it.hint}` : "";
        lines.push(`${marker} ${it.label}${hint}`);
      });
    } else if (cur.screen.body) {
      for (const l of cur.screen.body(this.ctx).slice(0, MAX_ROWS)) lines.push(l);
    }

    return lines;
  }

  private statusBar(): string {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const bt = this.ctx.pairReady() ? "BT" : "--";
    // battery() returns -1 until the real read lands (FUT-169) → show "?" not a fake number.
    const bat = this.ctx.battery();
    const batStr = bat < 0 ? "?" : `${bat}%`;
    return `FFS OS    ${time}    ${bt} ${batStr}`;
  }
}
