// Mount point for the "experience" layer, rendered once by Shell: the hyperspace jump watcher and the
// one-time welcome sheet. Renders nothing visible by itself.

import { useEffect } from "react";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { ErrorBoundary } from "./ErrorBoundary";
import { HyperspaceJump } from "./HyperspaceJump";
import { hasBeenWelcomed } from "./Welcome";

export function ExperienceLayer() {
  const loaded = useApp((s) => s.loaded);
  const loadError = useApp((s) => s.loadError);

  useEffect(() => {
    if (!loaded || loadError || hasBeenWelcomed()) return;
    // Let the shell paint first; never stack over a dialog the user already opened.
    const t = window.setTimeout(() => {
      if (!useUi.getState().dialog) useUi.getState().openDialog({ kind: "welcome" });
    }, 350);
    return () => window.clearTimeout(t);
  }, [loaded, loadError]);

  return (
    <ErrorBoundary scope="Effects">
      <HyperspaceJump />
    </ErrorBoundary>
  );
}
