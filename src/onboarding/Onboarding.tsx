import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { OnboardingStage, OnboardingStatus } from "../host/types";
import { copyToClipboard } from "../shared/clipboard";
import { cleanVersion } from "../shared/format";
import { usesOverlayTitlebar } from "../shared/platform";
import { Brand } from "../ui/Brand";
import { Icon } from "../ui/Icon";

export function Onboarding({
  stage,
  status,
  busyLabel,
  deviceAuthCode,
  error,
  titlebarHeight,
  onRetry,
  onOpenInstallGuide,
  onLogin,
}: {
  stage: OnboardingStage;
  status: OnboardingStatus | null;
  busyLabel: string | null;
  deviceAuthCode: string | null;
  error: string | null;
  titlebarHeight: number | null;
  onRetry: () => void;
  onOpenInstallGuide: () => void;
  onLogin: () => void;
}) {
  const overlayTitlebar = usesOverlayTitlebar();
  const dragRegionProps = overlayTitlebar ? { "data-tauri-drag-region": "deep" } : {};
  const cliReady = !["checking", "missingCli", "webOnly"].includes(stage);
  const authReady = ["ready", "connecting", "connected"].includes(stage);
  const currentStep = stage === "checking" ? "00" : stage === "missingCli" ? "01" : "02";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copyResetTimer = useRef<number | null>(null);
  const copyLabel = copyState === "copied" ? "COPIED" : copyState === "error" ? "RETRY" : "COPY";

  useEffect(() => {
    setCopyState("idle");
    return () => {
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    };
  }, [deviceAuthCode]);

  async function copyAuthCode() {
    if (!deviceAuthCode) return;

    try {
      await copyToClipboard(deviceAuthCode);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopyState("idle"), 2200);
  }

  return (
    <div
      className={`onboarding-shell ${overlayTitlebar ? "has-overlay-titlebar" : ""}`}
      style={overlayTitlebar && titlebarHeight !== null
        ? { "--app-header-height": `${titlebarHeight}px` } as CSSProperties
        : undefined}
    >
      <header className="onboarding-header" {...dragRegionProps}>
        <span>Desktop client for Grok Build</span>
      </header>

      <main className="onboarding-main">
        <div className={`onboarding-body ${deviceAuthCode ? "auth-code-active" : ""}`}>
          <div className="onboarding-brand">
            <Brand />
          </div>

          <section className={`setup-card ${deviceAuthCode ? "auth-code-active" : ""}`} aria-live="polite">
            <div className="setup-card-topline">
              <span>SETUP / {currentStep}</span>
              <span className="setup-signal"><i /><i /><i /><i /><i /></span>
            </div>

            <div className="setup-copy">
              {stage === "checking" && (
                <>
                  <p className="setup-kicker">SYSTEM CHECK</p>
                  <h1>Looking for<br />Grok Build.</h1>
                  <p>Checking the local CLI and its authentication state.</p>
                </>
              )}

              {stage === "webOnly" && (
                <>
                  <p className="setup-kicker">DESKTOP REQUIRED</p>
                  <h1>Open Groky<br />as an app.</h1>
                  <p>The web preview cannot start local processes. Run <code>pnpm tauri dev</code> to continue.</p>
                </>
              )}

              {stage === "missingCli" && (
                <>
                  <p className="setup-kicker">GROK BUILD CLI</p>
                  <h1>First, install<br />the engine.</h1>
                  <p>Groky uses the official Grok Build CLI locally. It never proxies your credentials.</p>
                  <div className="setup-actions">
                    <button className="primary-action" type="button" onClick={onOpenInstallGuide}>
                      Open install guide <Icon name="external-link" size={15} />
                    </button>
                    <button className="secondary-action" type="button" onClick={onRetry}>
                      <Icon name="refresh" size={15} /> Check again
                    </button>
                  </div>
                </>
              )}

              {stage === "needsAuth" && (
                <>
                  <p className="setup-kicker">ACCOUNT CONNECTION</p>
                  <h1>Sign in where<br />you trust.</h1>
                  <p>Groky opens xAI authentication in your browser and waits for approval. No code needs to be copied back into the app.</p>
                  <div className="setup-actions">
                    <button className="primary-action" type="button" onClick={onLogin} disabled={Boolean(busyLabel)}>
                      {busyLabel ?? "Sign in to Grok"} {!busyLabel && <Icon name="arrow-right" size={15} />}
                    </button>
                    <span className="version-note">CLI {cleanVersion(status?.cliVersion ?? null)}</span>
                  </div>
                </>
              )}

              {stage === "error" && (
                <>
                  <p className="setup-kicker error-kicker">CONNECTION INTERRUPTED</p>
                  <h1>Something broke<br />the handshake.</h1>
                  <p>{error ?? status?.message ?? "Groky could not connect to Grok Build."}</p>
                  <div className="setup-actions">
                    <button className="primary-action" type="button" onClick={onRetry}>
                      Try again <Icon name="refresh" size={15} />
                    </button>
                  </div>
                </>
              )}
            </div>

            <aside className={`setup-side ${deviceAuthCode ? "has-auth-code" : ""}`}>
              {deviceAuthCode && (
                <div className="device-auth-code">
                  <div className="device-auth-heading">
                    <span><i /> BROWSER VERIFICATION</span>
                    <button
                      className={`device-auth-copy ${copyState}`}
                      type="button"
                      aria-label={copyState === "copied" ? "Browser verification code copied" : copyState === "error" ? "Retry copying browser verification code" : "Copy browser verification code"}
                      onClick={() => void copyAuthCode()}
                    >
                      <Icon name={copyState === "copied" ? "check" : "copy"} size={12} />
                      <span aria-live="polite">{copyLabel}</span>
                    </button>
                  </div>
                  <strong role="status" aria-label={`Browser verification code ${deviceAuthCode}`}>{deviceAuthCode}</strong>
                  <small>Make sure this code matches the browser before you continue.</small>
                </div>
              )}

              <ol className="setup-rail" aria-label="Setup progress">
                <SetupStep index="01" label="Grok CLI" detail={cliReady ? cleanVersion(status?.cliVersion ?? null) : "Required"} state={cliReady ? "done" : stage === "missingCli" ? "current" : "waiting"} />
                <SetupStep index="02" label="Authentication" detail={authReady ? "Connected" : deviceAuthCode ? "Match browser code" : "Browser approval"} state={authReady ? "done" : stage === "needsAuth" ? "current" : "waiting"} />
              </ol>
            </aside>

            {(error && stage !== "error") && <p className="setup-inline-error">{error}</p>}
          </section>
        </div>
      </main>

      <footer className="onboarding-footer">
        <span><i className="privacy-dot" /> Credentials stay with the official Grok CLI</span>
        <span>ACP / LOCAL STDIO</span>
      </footer>
    </div>
  );
}

function SetupStep({ index, label, detail, state }: { index: string; label: string; detail: string; state: "done" | "current" | "waiting" }) {
  return (
    <li className={`setup-step ${state}`}>
      <span className="step-index">{state === "done" ? <Icon name="check" size={13} /> : index}</span>
      <span><strong>{label}</strong><small>{detail}</small></span>
      <i className="step-state" />
    </li>
  );
}
