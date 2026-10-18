import { describe, expect, it } from "vitest";
import {
  OS,
  cpuShareLabel,
  detectOs,
  executablePlaceholder,
  fileManagerName,
  folderPlaceholder,
  isLinux,
  isMac,
  isWindows,
  osNotificationName,
  shellLabel,
  webviewHint,
  webviewLabel,
} from "./platform";

describe("detectOs", () => {
  it("reads navigator.platform values of every engine", () => {
    expect(detectOs("Win32")).toBe("windows");
    expect(detectOs("Windows")).toBe("windows"); // userAgentData.platform
    expect(detectOs("MacIntel")).toBe("macos");
    expect(detectOs("macOS")).toBe("macos");
    expect(detectOs("iPad")).toBe("macos");
    expect(detectOs("Linux x86_64")).toBe("linux");
    expect(detectOs("Linux aarch64")).toBe("linux");
    expect(detectOs("X11")).toBe("linux");
  });
  it("falls back to the user agent, then to Windows", () => {
    expect(detectOs("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("macos");
    expect(detectOs(undefined, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("linux");
    expect(detectOs(undefined, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0")).toBe("windows");
    expect(detectOs("Darwin")).toBe("macos"); // contains "win" but is macOS
    expect(detectOs(undefined, undefined)).toBe("windows");
    expect(detectOs("", "Node.js/22")).toBe("windows");
  });
  it("exposes exactly one platform flag", () => {
    expect([isMac, isLinux, isWindows].filter(Boolean)).toHaveLength(1);
    expect(["windows", "macos", "linux"]).toContain(OS);
  });
});

describe("platform labels", () => {
  it("keeps Windows strings and names the Unix equivalents", () => {
    expect(shellLabel("windows")).toBe("PowerShell");
    expect(shellLabel("macos")).toBe("Shell");
    expect(shellLabel("linux")).toBe("Shell");
    expect(webviewLabel("windows")).toBe("WebView2");
    expect(webviewLabel("macos")).toBe("WebKit");
    expect(webviewHint("linux")).toMatch(/best effort/);
    expect(webviewHint("macos")).toMatch(/best effort/);
    expect(cpuShareLabel("windows")).toBe("CPU as in Task Manager");
    expect(cpuShareLabel("linux")).toBe("CPU");
    expect(folderPlaceholder("windows")).toBe("D:\\code\\project");
    expect(folderPlaceholder("macos").startsWith("/Users/")).toBe(true);
    expect(folderPlaceholder("linux").startsWith("/home/")).toBe(true);
    expect(executablePlaceholder("windows")).toBe("C:\\tools\\bin\\tool.exe");
    expect(executablePlaceholder("linux")).toBe("/usr/local/bin/tool");
    expect(fileManagerName("windows")).toBe("Explorer");
    expect(fileManagerName("macos")).toBe("Finder");
    expect(osNotificationName("windows")).toBe("Windows");
    expect(osNotificationName("macos")).toBe("macOS");
  });
});
