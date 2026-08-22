// NotificationsPanel — where the allowlist LIVES, in the app, visible and editable.
//
// ⭐ This screen is part of the privacy design, not documentation of it. An allowlist buried in a
//    constant that only a rebuild can change is a promise; one that is on screen, shows which apps
//    are really installed, and takes effect on the next notification is a control. Turning an app
//    OFF also forgets, immediately, everything already held for it.
//
// ⛔ NOT ONE MESSAGE BODY, SENDER OR CONVERSATION NAME IS RENDERED HERE, and none is held in React
//    state. The panel shows counts. That is deliberate: this screen gets screenshotted for reports
//    and demos, and a screenshot of a settings page should not be a screenshot of Yoni's messages.
//    The only place the content exists on the phone is the native store; the only place it goes is
//    the FFSM encoder and then the BLE wire.

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { theme } from "../os/theme";
import { Group, Row, SectionLabel } from "../os/ui";
import {
  DEFAULT_ALLOW,
  KNOWN_MESSAGING,
  labelFor,
  looksSensitive,
  normaliseAllowlist,
} from "./allowlist";
import {
  clearHeld,
  getAllowlist,
  getInstalled,
  openListenerSettings,
  requestRebind,
  setAllowlist as nativeSetAllowlist,
  setCaptureEnabled,
} from "./native";
import type { NotificationBridge } from "./useNotificationBridge";

export type NotificationsPanelProps = {
  /** The app-wide notification bridge (created once in AppInner via useNotificationBridge). */
  bridge: NotificationBridge;
};

const CATALOGUE = KNOWN_MESSAGING.map((a) => a.pkg);

export function NotificationsPanel({ bridge }: NotificationsPanelProps) {
  // The service lifecycle lives in the bridge (app-wide, see useNotificationBridge); the panel is
  // the VIEW plus its own local UI — the allowlist rows and the text input.
  const { available, canSend, pairReady, granted, bound, capture, stats, breakerOpen, pushNow, refresh } =
    bridge;
  const [allow, setAllow] = useState<string[]>(DEFAULT_ALLOW);
  const [installed, setInstalled] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");

  // The allowlist is native-owned and only THIS panel edits it, so it does not need the bridge's
  // 3 s poll — read it (and which apps are installed) once the module is available and after edits.
  useEffect(() => {
    if (!available) return;
    setAllow(getAllowlist());
    setInstalled(getInstalled(CATALOGUE));
  }, [available]);

  const toggle = (pkg: string) => {
    const next = allow.includes(pkg) ? allow.filter((p) => p !== pkg) : normaliseAllowlist([...allow, pkg]);
    setAllow(nativeSetAllowlist(next));
    setNote(
      allow.includes(pkg)
        ? `${labelFor(pkg)} is off — anything held for it has been forgotten.`
        : `${labelFor(pkg)} is on. It takes effect on its next notification.`,
    );
  };

  const addCustom = () => {
    const pkg = custom.trim();
    if (!pkg) return;
    if (looksSensitive(pkg)) {
      // A warning, not a block: it is Yoni's phone and his list. But this is the moment to be
      // sure, because everything downstream of the gate trusts that the list means what it says.
      setNote(`⚠️ "${pkg}" does not look like a messenger. Tap ADD again to allow it anyway.`);
      setCustom(`${pkg} `); // a changed value, so the second tap is a deliberate one
      return;
    }
    setAllow(nativeSetAllowlist(normaliseAllowlist([...allow, pkg])));
    setCustom("");
    setNote(`${pkg} added.`);
  };

  const doPushNow = () => {
    pushNow();
    setNote("pushing the current inbox…");
  };

  if (!available) {
    return (
      <View>
        <SectionLabel note="Android only">Notifications → glasses</SectionLabel>
        <Group>
          <Row
            badge="—"
            tint={theme.tint.grey}
            title="Not available on this platform"
            subtitle="iOS gives an app no read access to other apps' notifications. Android only, by the OS's design."
          />
        </Group>
      </View>
    );
  }

  const custIsWeird = custom.trim().length > 0 && looksSensitive(custom.trim());
  const grantTag = granted ? (bound ? "GRANTED" : "granted, unbound") : "NOT GRANTED";
  const grantTint = granted ? (bound ? theme.accent : theme.warn) : theme.danger;

  return (
    <View>
      <SectionLabel note="allowlist-only · nothing else is ever read">
        Notifications → glasses
      </SectionLabel>

      <Group>
        <Row
          badge="OS"
          tint={granted ? theme.tint.green : theme.tint.red}
          title={granted ? "Notification access granted" : "Grant notification access"}
          subtitle={
            granted
              ? bound
                ? "The listener is bound. New messages from the apps below reach the glasses."
                : "Granted but not bound — Android does this after an app update. Tap to re-bind."
              : "Opens Android settings. Only you can give this; there is no programmatic request."
          }
          tag={grantTag}
          tagTint={grantTint}
          onPress={() => {
            if (granted && !bound) {
              requestRebind();
              setTimeout(refresh, 800);
            } else {
              openListenerSettings();
            }
          }}
          // (the bridge also auto-rebinds while granted-but-unbound; this row is the manual nudge)
        />
        <Row
          divider
          badge={capture ? "ON" : "OFF"}
          tint={capture ? theme.tint.green : theme.tint.grey}
          title="Capture"
          subtitle={
            capture
              ? "Reading the allowlisted apps. Turning this off also forgets everything held."
              : "Nothing is being read at all, whatever the allowlist says."
          }
          tag={capture ? "live" : "paused"}
          tagTint={capture ? theme.accent : theme.textDim}
          onPress={() => {
            const next = !capture;
            setCaptureEnabled(next);
            refresh();
            setNote(next ? "capture on." : "capture off — everything held has been forgotten.");
          }}
        />
      </Group>

      <SectionLabel note={`${allow.length} allowed · everything else is dropped unread`}>
        The allowlist
      </SectionLabel>
      <Group>
        {KNOWN_MESSAGING.map((app, i) => {
          const on = allow.includes(app.pkg);
          const here = installed.includes(app.pkg);
          return (
            <Row
              key={app.pkg}
              divider={i > 0}
              badge={on ? "✓" : "·"}
              tint={on ? (here ? theme.tint.green : theme.tint.blue) : theme.tint.grey}
              title={app.label}
              subtitle={app.note ? `${app.pkg} — ${app.note}` : app.pkg}
              tag={here ? (on ? "on" : "off") : "not installed"}
              tagTint={here ? (on ? theme.accent : theme.textDim) : theme.textDim}
              onPress={() => toggle(app.pkg)}
            />
          );
        })}
        {allow
          .filter((p) => !CATALOGUE.includes(p))
          .map((pkg) => (
            <Row
              key={pkg}
              divider
              badge="✓"
              tint={theme.tint.amber}
              title={pkg}
              subtitle="added by hand — tap to remove"
              tag="custom"
              tagTint={theme.warn}
              onPress={() => toggle(pkg)}
            />
          ))}
      </Group>

      <View style={s.addRow}>
        <TextInput
          style={[s.input, custIsWeird && s.inputWarn]}
          value={custom}
          onChangeText={setCustom}
          placeholder="another messaging package, e.g. com.example.chat"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable style={s.addBtn} onPress={addCustom}>
          <Text style={s.addBtnText}>ADD</Text>
        </Pressable>
      </View>

      <SectionLabel note="counts only — never content">Held right now</SectionLabel>
      <Group>
        <Row
          badge="#"
          tint={theme.tint.blue}
          title={`${stats.threads} conversation${stats.threads === 1 ? "" : "s"} · ${stats.held} message${stats.held === 1 ? "" : "s"}`}
          subtitle={`read ${stats.posted} · dropped unread ${stats.dropped} · re-posts ignored ${stats.duplicates} · trimmed ${stats.evicted}`}
          tag={`rev ${stats.revision}`}
          tagTint={theme.textDim}
        />
        <Row
          divider
          badge={breakerOpen ? "⛔" : "→"}
          tint={breakerOpen ? theme.tint.red : canSend ? theme.tint.green : theme.tint.grey}
          title={breakerOpen ? "Auto-push paused — a push crashed a lens" : "Push the inbox to the glasses now"}
          subtitle={
            breakerOpen
              ? "The link dropped right after a push, so the channel stopped resending on its own. Tap to retry deliberately."
              : canSend
                ? "Sends the current inbox as an FFSC value for app 3 (messages)."
                : pairReady
                  ? "The CFW loader has not been seen in a device-info readback — read device info first."
                  : "The link is down. The value is held — it goes out on the first tick after it returns."
          }
          tag={breakerOpen ? "retry" : canSend ? "ready" : pairReady ? "no loader" : "held"}
          tagTint={breakerOpen ? theme.danger : canSend ? theme.accent : theme.warn}
          disabled={!canSend}
          onPress={doPushNow}
        />
        <Row
          divider
          badge="⌫"
          tint={theme.tint.red}
          title="Forget everything held"
          subtitle="Clears the in-memory store. Nothing was ever written to disk, so this is all of it."
          tag="instant"
          tagTint={theme.danger}
          onPress={() => {
            clearHeld();
            refresh(); // bridge re-reads the counts (also polled every 3 s)
            setNote("forgotten.");
          }}
        />
      </Group>

      {note ? <Text style={s.note}>{note}</Text> : null}
      <Text style={s.fine}>
        Nothing outside the allowlist is read, and nothing at all is written to disk or to a log.
        Messages go phone → BLE → glasses and stop there.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  addRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  input: {
    flex: 1,
    backgroundColor: theme.surface,
    color: theme.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  inputWarn: { borderWidth: 1, borderColor: theme.warn },
  addBtn: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  addBtnText: { color: theme.accent, fontWeight: "700", fontSize: 13 },
  note: { color: theme.textDim, fontSize: 12, marginTop: 8 },
  fine: { color: theme.textDim, fontSize: 11, marginTop: 6, lineHeight: 15 },
});

export default NotificationsPanel;
