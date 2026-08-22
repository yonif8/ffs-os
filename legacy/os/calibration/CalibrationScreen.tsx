//
// SDK Calibration Harness — the guided run (FUT-236).
//
// One instruction at a time, a big button, and a live counter proving capture is alive.
// The counter matters more than it looks: the failure mode this whole harness exists to
// kill is a human diligently performing gestures into a system that is recording nothing
// and saying nothing about it.
//
// The runner is generic — it executes whatever spec.ts declares and knows nothing about
// rings, gestures or protocols.
//

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import FfsBle from "../../../modules/ffs-ble";
import { theme } from "../theme";
import { Capture } from "./capture";
import { CALIBRATION_STEPS, STEP_COUNT, type CalibrationStep } from "./spec";

interface Props {
  appVersion: string;
  /** Called when the run finishes or is abandoned. */
  onExit: (completed: boolean) => void;
}

export default function CalibrationScreen({ appVersion, onExit }: Props) {
  const [index, setIndex] = useState(0);
  const [frames, setFrames] = useState(0);
  const [stepFrames, setStepFrames] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [btReady, setBtReady] = useState(true);
  const [done, setDone] = useState(false);
  const capture = useRef<Capture | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const step: CalibrationStep | undefined = CALIBRATION_STEPS[index];

  // Start capture once, for the whole run.
  useEffect(() => {
    const c = new Capture(appVersion);
    c.onRecord = (r, total) => {
      setFrames(total);
      // Bluetooth state is the one thing that can silently invalidate an entire run,
      // so it's surfaced rather than merely recorded.
      if (r.source === "state") setBtReady(r.data.state === "poweredOn");
    };
    c.start();
    capture.current = c;
    return () => {
      c.stop();
    };
  }, [appVersion]);

  // Entering a step: label the capture, fire its action, arm its timer.
  useEffect(() => {
    const c = capture.current;
    if (!c || !step || done) return;
    c.setStep(step.id);
    setStepFrames(0);

    switch (step.action) {
      case "checkBluetooth":
        // Nothing to call — the driver reports state changes and the banner reacts.
        break;
      case "scanAll":
        FfsBle.startScan();
        FfsBle.ringScan();
        break;
      case "connectGlasses":
        FfsBle.connect();
        break;
      case "readDeviceInfo":
        FfsBle.requestDeviceInfo();
        break;
      case "connectRing":
        FfsBle.ringScan();
        break;
      case "ringForget":
        FfsBle.ringForget();
        break;
      case "ringAdvStart":
        // Best-effort: needs a MAC we may not have. Either way the attempt is recorded,
        // so "we never tried" and "we tried and it refused" stay distinguishable.
        c.note("advStart attempted");
        break;
    }

    if (step.kind === "timed" && step.seconds) {
      setCountdown(step.seconds);
      timerRef.current = setInterval(() => {
        setCountdown((v) => {
          if (v === null) return null;
          if (v <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = null;
            setTimeout(() => advance("timer elapsed"), 0);
            return null;
          }
          return v - 1;
        });
      }, 1000);
    } else {
      setCountdown(null);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, done]);

  // Per-step counter, polled — cheap and avoids re-rendering on every single frame.
  useEffect(() => {
    if (!step || done) return;
    const t = setInterval(() => {
      const c = capture.current;
      if (c) setStepFrames(c.countFor(step.id));
    }, 500);
    return () => clearInterval(t);
  }, [step, done]);

  const advance = useCallback(
    (why: string) => {
      const c = capture.current;
      const cur = CALIBRATION_STEPS[index];
      if (c && cur) c.markExit(cur.id, why);
      if (index + 1 >= STEP_COUNT) {
        setDone(true);
        if (c) {
          const s = c.stop();
          c.note("run complete", { total: s.records.length });
        }
      } else {
        setIndex((i) => i + 1);
      }
    },
    [index]
  );

  if (done) {
    const s = capture.current?.summary();
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.doneWrap}>
          <Text style={styles.doneTitle}>Calibration complete</Text>
          <Text style={styles.doneBig}>{frames}</Text>
          <Text style={styles.doneSub}>records captured and sent</Text>
          <Text style={styles.help}>
            Everything was streamed as it happened, so Rico already has it — nothing to
            copy or send. You can close the app.
          </Text>
          {s ? (
            <View style={styles.tally}>
              {CALIBRATION_STEPS.map((st) => (
                <Text key={st.id} style={styles.tallyRow}>
                  {(s.perStep[st.id] ?? 0) > 0 ? "✓" : "—"} {st.title}
                  <Text style={styles.dim}> · {s.perStep[st.id] ?? 0}</Text>
                </Text>
              ))}
            </View>
          ) : null}
          <Pressable style={styles.btn} onPress={() => onExit(true)}>
            <Text style={styles.btnText}>Back to the app</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!step) return null;

  const isBlocked = step.action === "checkBluetooth" && !btReady;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.section}>{step.section}</Text>
        <Text style={styles.progress}>
          {index + 1} / {STEP_COUNT}
        </Text>
      </View>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${((index + 1) / STEP_COUNT) * 100}%` }]} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>{step.title}</Text>
        <Text style={styles.instruction}>{step.instruction}</Text>

        {step.reps ? (
          <Text style={styles.reps}>Do it {step.reps} times, pausing between each</Text>
        ) : null}

        {countdown !== null ? (
          <Text style={styles.countdown}>{countdown}s</Text>
        ) : null}

        {isBlocked ? (
          <Text style={styles.blocked}>
            Bluetooth is OFF — turn it on to continue. Nothing is being recorded until you do.
          </Text>
        ) : null}

        <View style={styles.liveBox}>
          <Text style={styles.liveNum}>{stepFrames}</Text>
          <Text style={styles.liveLabel}>records this step</Text>
          <Text style={styles.dim}>{frames} total</Text>
        </View>

        <Text style={styles.why}>Why: {step.answers}</Text>
      </ScrollView>

      <View style={styles.footer}>
        {step.kind === "timed" ? (
          <Text style={styles.help}>Advances automatically — just wait.</Text>
        ) : (
          <Pressable
            style={[styles.btn, isBlocked && styles.btnDisabled]}
            disabled={isBlocked}
            onPress={() => advance("human tapped done")}
          >
            <Text style={styles.btnText}>
              {step.kind === "auto" ? "Continue" : "Done — next"}
            </Text>
          </Pressable>
        )}
        <Pressable onPress={() => advance("human skipped")}>
          <Text style={styles.skip}>Skip this step</Text>
        </Pressable>
        <Pressable onPress={() => onExit(false)}>
          <Text style={styles.skip}>Quit calibration</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  section: { color: theme.accent, fontSize: 13, fontWeight: "700", letterSpacing: 1 },
  progress: { color: theme.textDim, fontSize: 13 },
  bar: { height: 3, backgroundColor: theme.surfaceAlt, marginTop: 8 },
  barFill: { height: 3, backgroundColor: theme.accent },
  body: { padding: 24, paddingBottom: 8 },
  title: { color: theme.text, fontSize: 26, fontWeight: "800", marginBottom: 14 },
  instruction: { color: theme.text, fontSize: 17, lineHeight: 25 },
  reps: { color: theme.accent, fontSize: 15, marginTop: 14, fontWeight: "600" },
  countdown: { color: theme.accent, fontSize: 54, fontWeight: "800", marginTop: 18 },
  blocked: {
    color: theme.danger,
    fontSize: 15,
    marginTop: 18,
    fontWeight: "600",
    lineHeight: 21,
  },
  liveBox: {
    marginTop: 26,
    padding: 16,
    borderRadius: 12,
    backgroundColor: theme.surface,
    alignItems: "center",
  },
  liveNum: { color: theme.text, fontSize: 34, fontWeight: "800" },
  liveLabel: { color: theme.textDim, fontSize: 13 },
  dim: { color: theme.textDim, fontSize: 12 },
  why: { color: theme.textDim, fontSize: 12, marginTop: 20, lineHeight: 17 },
  footer: { padding: 20, gap: 10 },
  btn: {
    backgroundColor: theme.accent,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  skip: { color: theme.textDim, fontSize: 13, textAlign: "center", paddingVertical: 4 },
  help: { color: theme.textDim, fontSize: 13, textAlign: "center", lineHeight: 19 },
  doneWrap: { padding: 28, alignItems: "center" },
  doneTitle: { color: theme.text, fontSize: 26, fontWeight: "800", marginBottom: 18 },
  doneBig: { color: theme.accent, fontSize: 60, fontWeight: "800" },
  doneSub: { color: theme.textDim, fontSize: 15, marginBottom: 18 },
  tally: { alignSelf: "stretch", marginTop: 22, marginBottom: 22, gap: 4 },
  tallyRow: { color: theme.text, fontSize: 13 },
});
