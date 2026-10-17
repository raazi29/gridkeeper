// App-level context menu host (mounted once by Shell). Renders:
//  - terminal right-click menus requested by the terminal registry through menuBridge (no React there);
//  - menus opened with `openAppMenu` from places whose own tree may unmount while the menu is open
//    (e.g. Comms rows: the popover closes on outside clicks).

import { useEffect } from "react";
import { create } from "zustand";
import { onTerminalMenu } from "../terminal/menuBridge";
import { buildSessionMenu } from "./menus/sessionMenu";
import { Menu, type MenuItem, type MenuState } from "./ui/Menu";
import { useApp } from "../store/appStore";

const useAppMenu = create<{ menu: (MenuState & { seq: number }) | null }>()(() => ({ menu: null }));
let seq = 0;

export function openAppMenu(x: number, y: number, items: MenuItem[]): void {
  useAppMenu.setState({ menu: { x, y, items, seq: ++seq } });
}

export function closeAppMenu(): void {
  useAppMenu.setState({ menu: null });
}

export function ContextMenuHost() {
  const menu = useAppMenu((s) => s.menu);
  useEffect(
    () =>
      onTerminalMenu((req) => {
        if (useApp.getState().focusedSessionId !== req.sessionId) useApp.getState().setFocused(req.sessionId);
        openAppMenu(req.x, req.y, buildSessionMenu(req.sessionId, { surface: "terminal", hasSelection: req.hasSelection }));
      }),
    [],
  );
  if (!menu) return null;
  return <Menu key={menu.seq} x={menu.x} y={menu.y} items={menu.items} onClose={closeAppMenu} />;
}
