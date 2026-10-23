import { describe, it, expect } from "vitest";
import { pulseNotifyVitePlugin } from "../src/vitePlugin";

describe("pulseNotifyVitePlugin", () => {
  it("returns a plugin with the expected name and a transform hook", () => {
    const plugin = pulseNotifyVitePlugin();
    expect(plugin.name).toBe("pulse-notify:ssr-event-source-shim");
    expect(typeof plugin.transform).toBe("function");
  });

  it("returns a fresh plugin object per call", () => {
    expect(pulseNotifyVitePlugin()).not.toBe(pulseNotifyVitePlugin());
  });

  it("prepends the stub for SSR modules that reference EventSource", () => {
    const code = "const es = new EventSource('/x');";
    const result = pulseNotifyVitePlugin().transform!(code, "a.ts", { ssr: true });
    expect(result).not.toBeNull();
    expect(result!.code.endsWith(code)).toBe(true);
    expect(result!.code).toContain("class EventSourceStub");
    expect(result!.code.length).toBeGreaterThan(code.length);
  });

  it("returns null for non-SSR transforms", () => {
    const plugin = pulseNotifyVitePlugin();
    expect(plugin.transform!("new EventSource()", "a.ts", { ssr: false })).toBeNull();
    expect(plugin.transform!("new EventSource()", "a.ts", {})).toBeNull();
  });

  it("returns null when options are omitted", () => {
    expect(pulseNotifyVitePlugin().transform!("new EventSource()", "a.ts")).toBeNull();
  });

  it("returns null for SSR modules that do not reference EventSource", () => {
    expect(
      pulseNotifyVitePlugin().transform!("export const a = 1;", "a.ts", { ssr: true }),
    ).toBeNull();
  });

  it("injected stub defines EventSource only when undefined", () => {
    const out = pulseNotifyVitePlugin().transform!("EventSource;", "a.ts", { ssr: true })!;
    const g = globalThis as Record<string, unknown>;
    const original = g.EventSource;
    try {
      delete g.EventSource;
      new Function(out.code.replace(/EventSource;$/, ""))();
      const Stub = g.EventSource as any;
      expect(Stub.CLOSED).toBe(2);
      expect(new Stub().readyState).toBe(2);
      const sentinel = class {};
      g.EventSource = sentinel;
      new Function(out.code.replace(/EventSource;$/, ""))();
      expect(g.EventSource).toBe(sentinel);
    } finally {
      if (original === undefined) delete g.EventSource;
      else g.EventSource = original;
    }
  });
});
