"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceEnroll } from "../../components/voice/voice-enroll";
import {
  FEATURE_SPEC,
  type EnrollProgress,
  type Modality,
} from "../../lib/contracts";
import { startPresence } from "../../sdk/presence";
import styles from "./page.module.css";

type Progress = Pick<EnrollProgress, "counts" | "gates" | "ready">;
// Enrollment gates come from feature_spec.yaml (via the generated contracts) so the
// wizard always matches what the model actually requires.
const gates = Object.entries(FEATURE_SPEC.modalities).map(
  ([m, spec]) => [m as Modality, spec.enroll_gate] as const,
);
const labels: Record<string, string> = {
  keyboard: "Typing rhythm",
  mouse: "Pointer movement",
  scroll: "Scrolling",
  workflow: "App & window changes",
  temporal: "Activity rhythm",
};
const practice =
  "A familiar rhythm emerges as you work. Write a short plan for your day, pause to think, and correct a few words. Switch between your usual apps, move the pointer, and scroll naturally.";

async function request<T>(url: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, {
    credentials: "same-origin",
    ...(data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Sign in to continue enrollment."
        : `Request failed (${response.status}). Please try again.`,
    );
  return response.json() as Promise<T>;
}

export default function EnrollPage() {
  const [device, setDevice] = useState("");
  const [progress, setProgress] = useState<Progress>({
    counts: {},
    gates: {},
    ready: false,
  });
  const [step, setStep] = useState(0);
  const [connection, setConnection] = useState("Connecting");
  const [mode, setMode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState("");
  const [model, setModel] = useState("");
  const [totp, setTotp] = useState("");
  const [totpVisible, setTotpVisible] = useState(false);
  const [typed, setTyped] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const deviceRef = useRef("");

  useEffect(() => startPresence(), []);
  useEffect(() => {
    deviceRef.current = device;
  }, [device]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let socket: WebSocket;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live`,
      );
      socket.onopen = () => {
        if (!stopped) setConnection("Live");
      };
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(data);
          if (
            deviceRef.current &&
            event.device_id &&
            event.device_id !== deviceRef.current
          )
            return;
          if (event.type === "snapshot") {
            if (event.data.device?.id) {
              deviceRef.current = event.data.device.id;
              setDevice(event.data.device.id);
            }
            if (event.data.enroll) setProgress(event.data.enroll);
            if (event.data.device?.mode) setMode(event.data.device.mode);
            if (event.data.model?.version) setModel(event.data.model.version);
          }
          if (event.type === "enroll_progress") setProgress(event.data);
          if (event.type === "mode") setMode(event.data.mode);
          if (event.type === "model") {
            setModel(event.data.version ?? "");
            setJob("");
            if (event.data.status === "failed")
              setError(
                "Training failed. Collect more natural activity and try again.",
              );
          }
        } catch {
          setError(
            "A live update could not be read. Reconnecting will refresh enrollment.",
          );
        }
      };
      socket.onclose = () => {
        if (!stopped) {
          setConnection("Reconnecting");
          timer = setTimeout(connect, 2000);
        }
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      if (textarea.current) textarea.current.value = "";
    };
  }, []);

  const act = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }, []);
  const start = () =>
    act(async () => {
      await request("/enroll/mode", { device_id: device, mode: "enroll" });
      setMode("enroll");
      setStep(1);
    });
  const train = () =>
    act(async () => {
      const result = await request<{ job_id: string }>("/enroll/train", {
        device_id: device,
        source: "tiger",
      });
      setJob(result.job_id);
    });
  const total = gates.length;
  const complete = gates.filter(
    ([m, n]) => (progress.counts[m] ?? 0) >= n,
  ).length;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a href="/" className={styles.brand}>
          2b<span>ME</span>
        </a>
        <a href="/dashboard">Back to dashboard ↗</a>
      </header>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>YOUR BEHAVIORAL IDENTITY</p>
        <h1>
          Let your rhythm
          <br />
          be your signature.
        </h1>
        <p>
          Build a private baseline from the way you type, move, and work. The
          more natural the activity, the more useful your model.
        </p>
      </div>
      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label="Enrollment steps">
          {[
            "Connect your Mac",
            "Build your baseline",
            "Add voice & recovery",
            "Train your identity",
          ].map((label, i) => (
            <button
              key={label}
              aria-current={step === i ? "step" : undefined}
              onClick={() => {
                if (textarea.current) textarea.current.value = "";
                setTyped(false);
                setTotpVisible(false);
                setStep(i);
              }}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              {label}
            </button>
          ))}
          <div className={styles.privacy}>
            <span aria-hidden>◈</span>
            <strong>Timing, never your words.</strong>
            <p>
              Typed text stays in this browser and is cleared when you leave
              this step. Only aggregate behavior statistics leave your Mac.
            </p>
          </div>
        </aside>
        <section className={styles.card} aria-labelledby="step-title">
          <div className={styles.cardTop}>
            <span>STEP {step + 1} / 4</span>
            <span className={styles.connection}>{connection}</span>
          </div>
          {step === 0 && (
            <>
              <h2 id="step-title">Connect your capture agent.</h2>
              <p>
                Pair the macOS agent from Terminal, grant Input Monitoring, then
                keep it running while you enroll.
              </p>
              <ol className={styles.instructions}>
                <li>
                  Run <code>twobme-agent pair</code> and sign in.
                </li>
                <li>
                  Run <code>twobme-agent doctor</code> to check capture.
                </li>
                <li>
                  Start <code>twobme-agent run --mode enroll --record</code>.
                </li>
              </ol>
              <div className={styles.status}>
                {device
                  ? "Your Mac is connected."
                  : "Waiting for a paired Mac…"}
              </div>
              <button
                className={styles.primary}
                disabled={!device || busy}
                onClick={start}
              >
                {busy ? "Starting…" : "Start enrollment →"}
              </button>
            </>
          )}
          {step === 1 && (
            <>
              <h2 id="step-title">Work the way you usually do.</h2>
              <p>
                Try the passage below, or write something of your own. Use your
                usual apps between typing sessions.
              </p>
              <blockquote>{practice}</blockquote>
              <label htmlFor="typing">
                Practice area · nothing typed here is submitted
              </label>
              <textarea
                id="typing"
                ref={textarea}
                autoComplete="off"
                spellCheck={false}
                placeholder="Start typing here…"
                onInput={() => setTyped(true)}
              />
              <div className={styles.small}>
                {typed
                  ? "Practice text stays on this page."
                  : "Take your time. Pauses and corrections are part of your rhythm."}
              </div>
              <button
                className={styles.secondary}
                onClick={() => {
                  if (textarea.current) textarea.current.value = "";
                  setTyped(false);
                }}
              >
                Clear practice text
              </button>
              <button
                className={styles.primary}
                onClick={() => {
                  if (textarea.current) textarea.current.value = "";
                  setStep(2);
                }}
              >
                Continue to voice & recovery →
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <h2 id="step-title">A second way to know it’s you.</h2>
              <p>
                Enroll your voice for identity checks, and add an authenticator
                as a recovery option.
              </p>
              <VoiceEnroll />
              <div className={styles.recovery}>
                <h3>Authenticator recovery</h3>
                <p>Set up time-based codes in your authenticator app.</p>
                <button
                  className={styles.secondary}
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const r = await request<{ otpauth_uri: string }>(
                        "/voice/totp/enroll",
                        {},
                      );
                      setTotp(r.otpauth_uri);
                      setTotpVisible(true);
                    })
                  }
                >
                  {totp ? "Regenerate setup" : "Set up authenticator"}
                </button>
                {totp && (
                  <>
                    <button
                      className={styles.secondary}
                      onClick={() => setTotpVisible(!totpVisible)}
                    >
                      {totpVisible ? "Hide setup" : "Show setup"}
                    </button>
                    {totpVisible && (
                      <a className={styles.setupLink} href={totp}>
                        Open authenticator setup
                      </a>
                    )}
                    <p className={styles.small}>
                      Keep setup private. Enrollment is complete only when the
                      voice service confirms it.
                    </p>
                  </>
                )}
              </div>
              <button
                className={styles.primary}
                onClick={() => {
                  setTotpVisible(false);
                  setStep(3);
                }}
              >
                Review & train →
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <h2 id="step-title">Your first identity model.</h2>
              <p>
                Training uses eligible enrollment activity and reserves
                chronological folds for calibration. Underfilled signals stay
                disabled.
              </p>
              <div className={styles.status}>
                {complete} of {total} collection goals reached ·{" "}
                {mode || "Waiting for agent"}
              </div>
              <button
                className={styles.primary}
                disabled={busy || !device || !progress.ready || !!job}
                onClick={train}
              >
                {job
                  ? "Training in progress…"
                  : busy
                    ? "Submitting…"
                    : "Train identity model"}
              </button>
              {!progress.ready && (
                <p className={styles.small}>
                  Keep collecting natural activity until the server confirms
                  training is ready.
                </p>
              )}
              {job && (
                <p role="status">
                  Training job submitted. Keep this page open for the result.
                </p>
              )}
              {model && (
                <div className={styles.model}>
                  <strong>Model ready</strong>
                  <code>{model}</code>
                  <button
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await request("/enroll/mode", {
                          device_id: device,
                          mode: "monitor",
                        });
                        setMode("monitor");
                        location.assign("/dashboard");
                      })
                    }
                  >
                    Start monitoring →
                  </button>
                </div>
              )}
            </>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </section>
        <aside className={styles.progress}>
          <p className={styles.eyebrow}>LIVE COLLECTION</p>
          <h2>
            A fuller picture,
            <br />
            one signal at a time.
          </h2>
          {gates.map(([m, goal]) => {
            const count = progress.counts[m] ?? 0;
            return (
              <div className={styles.signal} key={m}>
                <div>
                  <label htmlFor={`gate-${m}`}>{labels[m]}</label>
                  <span>
                    {count} / {goal}
                  </span>
                </div>
                <progress
                  id={`gate-${m}`}
                  max={goal}
                  value={Math.min(count, goal)}
                />
                <small>
                  {count >= goal
                    ? "Collection goal reached"
                    : m === "temporal"
                      ? "Non-overlapping 30-second windows"
                      : "Evidence blocks"}
                </small>
              </div>
            );
          })}
          <p className={styles.small}>
            Voice is a separate check. Behavioral differences can request
            verification; they never block you on their own.
          </p>
        </aside>
      </div>
    </main>
  );
}
