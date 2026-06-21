import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  DEFAULT_QUIT_COMBO,
  quitButtonGlyph,
} from "@/components/quit-hotkey/combo";

/**
 * Display-only "hold to return to Retrom" indicator, rendered in the dedicated,
 * transparent, click-through `quit-indicator` window (see
 * retrom-plugin-launcher's `quit.rs`). It takes no input or focus — it only
 * reacts to the `quit-hold:*` events the native gamepad reader emits while the
 * quit-to-library combo is held, drawing a filling ring over the game.
 *
 * Themed to match Big Picture: dark glass + purple accent. The combo glyphs come
 * from the `quit-hold:start` payload, so they reflect the buttons actually bound
 * (the combo is XInput/Xbox-specific, so Xbox glyphs are always correct here).
 */

// Big Picture purple accent.
const ACCENT = "#8b6cf6";

const RING_RADIUS = 34;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type Phase = "idle" | "holding" | "confirmed";

type HoldStart = { durationMs?: number; buttons?: number[] };

export function QuitIndicator() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [durationMs, setDurationMs] = useState(1500);
  const [buttons, setButtons] = useState<number[]>([...DEFAULT_QUIT_COMBO]);
  // Bumped on each new hold so the ring/pill animations restart cleanly via key.
  const [holdId, setHoldId] = useState(0);
  const [reduceMotion] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );

  // The host window is transparent; clear the inherited app background so only
  // our pill paints, and restore it if this ever unmounts.
  useEffect(() => {
    const html = document.documentElement.style.background;
    const body = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";

    return () => {
      document.documentElement.style.background = html;
      document.body.style.background = body;
    };
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    const track = (p: Promise<() => void>) => {
      void p.then((fn) => (disposed ? fn() : unlisteners.push(fn)));
    };

    track(
      listen<HoldStart>("quit-hold:start", ({ payload }) => {
        setDurationMs(payload?.durationMs ?? 1500);
        if (payload?.buttons && payload.buttons.length > 0) {
          setButtons(payload.buttons);
        }
        setHoldId((id) => id + 1);
        setPhase("holding");
      }),
    );
    track(listen("quit-hold:cancel", () => setPhase("idle")));
    track(listen("quit-hold:confirm", () => setPhase("confirmed")));

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  if (phase === "idle") {
    return null;
  }

  const animate = !reduceMotion;
  const confirmed = phase === "confirmed";

  // Inside the ring, show the last combo button that has dedicated art (combos
  // usually end on an action/menu button); fall back to the first glyph.
  const centerGlyph =
    [...buttons]
      .reverse()
      .map(quitButtonGlyph)
      .find((g) => g.src) ??
    quitButtonGlyph(buttons[0] ?? DEFAULT_QUIT_COMBO[2]);

  // Ring fill: animate from empty to full over the hold duration; on confirm (or
  // with reduced motion) snap to full.
  const ringStyle: React.CSSProperties =
    confirmed || !animate
      ? { strokeDashoffset: 0 }
      : {
          "--quit-circ": `${RING_CIRCUMFERENCE}`,
          animation: `quit-fill-ring ${durationMs}ms linear forwards`,
        };

  return (
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ pointerEvents: "none", userSelect: "none" }}
    >
      <style>{`
        @keyframes quit-fill-ring {
          from { stroke-dashoffset: var(--quit-circ); }
          to { stroke-dashoffset: 0; }
        }
        @keyframes quit-pill-in {
          from { opacity: 0; transform: translateY(10px) scale(0.96); }
          to { opacity: 1; transform: none; }
        }
        @keyframes quit-pop {
          0% { transform: scale(1); }
          45% { transform: scale(1.06); }
          100% { transform: scale(1); }
        }
      `}</style>

      <div
        key={holdId}
        style={{
          marginBottom: "12vh",
          padding: "20px 26px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "14px",
          borderRadius: "20px",
          background: "rgba(12, 12, 18, 0.74)",
          border: `1px solid ${confirmed ? ACCENT : "rgba(139, 108, 246, 0.45)"}`,
          boxShadow: `0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0,0,0,0.25)`,
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          color: "#f3f1fb",
          animation: animate
            ? confirmed
              ? "quit-pop 280ms ease-out"
              : "quit-pill-in 160ms ease-out"
            : undefined,
        }}
      >
        <div style={{ position: "relative", width: 88, height: 88 }}>
          <svg width="88" height="88" viewBox="0 0 100 100">
            {/* Track */}
            <circle
              cx="50"
              cy="50"
              r={RING_RADIUS}
              fill="none"
              stroke="rgba(255, 255, 255, 0.14)"
              strokeWidth="6"
            />
            {/* Fill */}
            <circle
              cx="50"
              cy="50"
              r={RING_RADIUS}
              fill="none"
              stroke={ACCENT}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              transform="rotate(-90 50 50)"
              style={ringStyle}
            />
          </svg>

          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {centerGlyph.src ? (
              <img
                src={centerGlyph.src}
                alt={centerGlyph.label}
                style={{ width: 34, height: 34, objectFit: "contain" }}
              />
            ) : (
              <span style={{ fontSize: 15, fontWeight: 700 }}>
                {centerGlyph.label}
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "13px",
            opacity: 0.92,
          }}
        >
          {buttons.map((button, i) => {
            const glyph = quitButtonGlyph(button);
            return (
              <span
                key={`${button}-${i}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                {i > 0 && <Plus />}
                {glyph.src ? (
                  <Glyph src={glyph.src} alt={glyph.label} />
                ) : (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      padding: "2px 6px",
                      borderRadius: 6,
                      background: "rgba(255,255,255,0.12)",
                    }}
                  >
                    {glyph.label}
                  </span>
                )}
              </span>
            );
          })}
        </div>

        <div
          style={{
            fontSize: "15px",
            fontWeight: 600,
            letterSpacing: "0.02em",
            textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          }}
        >
          {confirmed ? "Returning to Retrom…" : "Hold to return to Retrom"}
        </div>
      </div>
    </div>
  );
}

function Glyph({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      style={{ width: 26, height: 26, objectFit: "contain" }}
    />
  );
}

function Plus() {
  return (
    <span style={{ opacity: 0.55, fontSize: "13px", fontWeight: 600 }}>+</span>
  );
}
