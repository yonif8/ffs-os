// Status widget — MicLight.
//
// A privacy light: lit when the glasses opened their OWN microphone unprompted
// (`onMicUnexpected` with requestedByUs === false). This is the only place that fact is
// visible to the wearer, so the lit state is sticky until dismissed. Metadata only — a
// side and a clock reading; never audio or anything derived from audio.

import { Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "../theme";
import { SectionLabel } from "../ui";

export type MicAlert = { side: string; at: number; n: number } | null;

export type MicLightProps = {
  alert: MicAlert;
  onDismiss: () => void;
};

export function MicLight({ alert, onDismiss }: MicLightProps) {
  const lit = alert != null;
  return (
    <>
      <SectionLabel note="privacy">Microphone</SectionLabel>
      <View style={[s.card, lit && s.cardLit]}>
        <View style={s.head}>
          <View style={[s.light, { backgroundColor: lit ? theme.danger : theme.surfaceAlt }]} />
          <Text style={[s.title, { color: lit ? theme.danger : theme.textDim }]}>
            {lit ? "The glasses opened their own microphone" : "Mic idle — no unprompted opens"}
          </Text>
        </View>
        {lit && alert ? (
          <>
            <Text style={s.body}>
              Audio started from the {alert.side === "L" ? "left" : "right"} lens at{" "}
              {new Date(alert.at).toLocaleTimeString()} and this phone never asked for it — a wake
              word or a temple long-press into Even's own voice flow.
              {alert.n > 1 ? `  (${alert.n}× this session)` : ""}
            </Text>
            <Text style={s.body}>
              Nothing was recorded, logged or sent: the audio characteristic is dropped in the driver
              before it can reach a log, JavaScript or the network.
            </Text>
            <Pressable onPress={onDismiss} hitSlop={8}>
              <Text style={s.dismiss}>Dismiss</Text>
            </Pressable>
          </>
        ) : null}
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
  cardLit: { borderColor: theme.danger },
  head: { flexDirection: "row", alignItems: "center" },
  light: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  title: { fontSize: 13, fontWeight: "700", flex: 1 },
  body: { color: theme.textDim, fontSize: 12, lineHeight: 16.5, marginTop: 8 },
  dismiss: { color: theme.accent, fontSize: 13, fontWeight: "700", marginTop: 10 },
});
