import { describe, expect, it } from "vitest";
import { displayUrl, frameMode, isAppOrigin, isLocalDevUrl, localPortOf, MAX_URL_LEN, normalizeUrlInput, urlForPort, validateUrl } from "./url";

describe("validateUrl", () => {
  it("accepts http, https and file", () => {
    expect(validateUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(validateUrl(" https://example.com/a?b=1#c ")).toBe("https://example.com/a?b=1#c");
    expect(validateUrl("file:///C:/docs/index.html")).toBe("file:///C:/docs/index.html");
  });
  it("rejects other schemes, whitespace, credentials and overlong URLs", () => {
    for (const bad of ["", "javascript:alert(1)", "data:text/html,x", "tauri://localhost", "ftp://x.com", "http://exa mple.com", "https://u:p@x.com/", "about:blank"])
      expect(validateUrl(bad), bad).toBeNull();
    expect(validateUrl(`https://x.com/${"a".repeat(MAX_URL_LEN)}`)).toBeNull();
  });
});

describe("normalizeUrlInput", () => {
  it("turns ports and localhost forms into http URLs", () => {
    expect(normalizeUrlInput("5173")).toBe("http://localhost:5173/");
    expect(normalizeUrlInput(":3000")).toBe("http://localhost:3000/");
    expect(normalizeUrlInput(":3000/docs")).toBe("http://localhost:3000/docs");
    expect(normalizeUrlInput("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeUrlInput("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(normalizeUrlInput("app.localhost:3000")).toBe("http://app.localhost:3000/");
  });
  it("defaults bare domains to https and keeps explicit schemes", () => {
    expect(normalizeUrlInput("example.com/path")).toBe("https://example.com/path");
    expect(normalizeUrlInput("http://example.com")).toBe("http://example.com/");
  });
  it("turns Windows paths into file URLs", () => {
    expect(normalizeUrlInput("C:\\docs\\a b.html")).toBe("file:///C:/docs/a%20b.html");
  });
  it("turns absolute POSIX paths into file URLs on macOS / Linux only", () => {
    expect(normalizeUrlInput("/home/me/a b.html", "linux")).toBe("file:///home/me/a%20b.html");
    expect(normalizeUrlInput("/Users/me/x.html", "macos")).toBe("file:///Users/me/x.html");
    expect(normalizeUrlInput("/home/me/a.html", "windows")).toBeNull();
    expect(normalizeUrlInput("//server/x", "linux")).toBeNull();
  });
  it("refuses unusable input", () => {
    for (const bad of ["", "   ", "hello", "javascript:alert(1)", "data:text/html,x", "99999", "mailto:a@b.c"]) expect(normalizeUrlInput(bad), bad).toBeNull();
  });
});

describe("frame rules", () => {
  const own = "http://tauri.localhost";
  it("never frames the app's own origins", () => {
    expect(isAppOrigin("http://tauri.localhost/index.html", own)).toBe(true);
    expect(isAppOrigin("http://ipc.localhost/x", own)).toBe(true);
    expect(isAppOrigin("http://localhost:1420/", "http://localhost:1420")).toBe(true);
    expect(isAppOrigin("http://localhost:5173/", "http://localhost:1420")).toBe(false);
    expect(frameMode("http://tauri.localhost/", own)).toBe("blocked");
    expect(frameMode("http://localhost:1420/", "http://localhost:1420")).toBe("blocked");
  });
  it("frames http(s), sends file: to a window, rejects the rest", () => {
    expect(frameMode("http://localhost:5173/", own)).toBe("frame");
    expect(frameMode("https://example.com/", own)).toBe("frame");
    expect(frameMode("file:///C:/a.html", own)).toBe("window");
    expect(frameMode("javascript:alert(1)", own)).toBe("invalid");
    expect(frameMode(null, own)).toBe("invalid");
  });
  it("recognises local dev servers and their ports", () => {
    expect(isLocalDevUrl("http://localhost:5173/")).toBe(true);
    expect(isLocalDevUrl("http://127.0.0.1:3000/")).toBe(true);
    expect(isLocalDevUrl("http://[::1]:3000/")).toBe(true);
    expect(isLocalDevUrl("http://tauri.localhost/")).toBe(false);
    expect(isLocalDevUrl("https://example.com/")).toBe(false);
    expect(localPortOf("http://localhost:5173/x")).toBe(5173);
    expect(localPortOf("http://localhost/")).toBe(80);
    expect(localPortOf("https://example.com:5173/")).toBeNull();
    expect(urlForPort(8080)).toBe("http://localhost:8080/");
    expect(displayUrl("http://localhost:5173/")).toBe("localhost:5173");
    expect(displayUrl("https://example.com/a/")).toBe("example.com/a/");
  });
});
