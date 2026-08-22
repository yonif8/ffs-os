// Status widget — Flash.
//
// Live CFW flash progress. Hidden until a flash starts, then shows the driver's
// `onFlashProgress` (a message + a 0…1 bar) as the OTA writes both lenses, and finally the
// terminal result. Auto-hides a few seconds after a SUCCESSFUL flash; a FAILURE stays on
// screen (a brick warning shouldn't vanish on its own). The native flasher (G2Flasher) is
// kept by the bridge — this widget just renders what it already emits.

import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import FfsBle from "../../../modules/ffs-ble";
import { theme } from "../theme";
import { Progress, SectionLabel } from "../ui";

type FlashState = { message: string; progress: number; done: boolean; ok: boolean };

export function Flash() {
  const [st, setSt] = useState<FlashState | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
    const sub = FfsBle.addListener("onFlashProgress", (e) => {
      clear();
      setSt({ message: e.message, progress: e.progress, done: e.done, ok: e.ok });
      // Clear a short while after a SUCCESSFUL flash; keep failures until the next flash starts.
      if (e.done && e.ok) hideTimer.current = setTimeout(() => setSt(null), 6000);
    });
    return () => {
      sub.remove();
      clear();
    };
  }, []);

  if (!st) return null;

  const tint = st.done ? (st.ok ? theme.accent : theme.danger) : theme.warn;
  const note = st.done ? (st.ok ? "done" : "failed") : `${Math.round(st.progress * 100)}%`;

  return (
    <>
      <SectionLabel note={note}>Flash</SectionLabel>
      <View style={s.card}>
        <Text
          style={[s.msg, st.done && !st.ok ? { color: theme.danger } : null]}
          numberOfLines={2}
        >
          {st.message}
        </Text>
        <Progress frac={st.progress} tint={tint} />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.surfaceAlt,
    padding: 12,
  },
  msg: { color: theme.text, fontSize: 13, marginBottom: 10, fontFamily: "Menlo" },
});
