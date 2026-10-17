// Mount point for the "experience" layer, rendered once by Shell: the hyperspace jump watcher, the saber
// duel watcher and the one-time welcome sheet. Renders nothing visible by itself.

import { useEffect } from "react";
import { ipc } from "../lib/ipc";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { ErrorBoundary } from "./ErrorBoundary";
import { HyperspaceJump } from "./HyperspaceJump";
import { SaberDuel } from "./SaberDuel";
import { hasBeenWelcomed } from "./Welcome";

export function ExperienceLayer() {
  const loaded = useApp((s) => s.loaded);
  const loadError = useApp((s) => s.loadError);

  useEffect(() => {
    if (!loaded || loadError || hasBeenWelcomed()) return;
    let cancelled = false;
    // Let the shell paint first; never stack over a dialog the user already opened, and never in bench
    // mode (a modal would suspend shortcuts and skew measurements).
    const t = window.setTimeout(() => {
      void ipc
        .appInfo()
        .catch(() => null)
        .then((info) => {
          if (cancelled || info?.bench || useUi.getState().dialog) return;
          useUi.getState().openDialog({ kind: "welcome" });
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [loaded, loadError]);

  return (
    <ErrorBoundary scope="Effects">
      <HyperspaceJump />
      <SaberDuel />
    </ErrorBoundary>
  );
}
