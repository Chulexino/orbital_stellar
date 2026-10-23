import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { StellarConnectionStatus } from "../src/StellarConnectionStatus.js";
import { __resetConnectionPoolForTests } from "../src/connectionPool.js";

// ---------------------------------------------------------------------------
// Minimal EventSource stub to avoid any real network activity
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(event: unknown, lastEventId?: string) {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId });
  }

  emitRaw(data: string) {
    this.onmessage?.({ data });
  }
}

let originalEventSource: typeof globalThis.EventSource;

beforeEach(() => {
  originalEventSource = globalThis.EventSource;
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  MockEventSource.instances = [];

  // Stub network fetch & RPC to guarantee no network is used
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network disabled in unit tests")));
});

afterEach(() => {
  cleanup();
  globalThis.EventSource = originalEventSource;
  __resetConnectionPoolForTests();
  vi.restoreAllMocks();
});

const SERVER = "https://events.example.com";
const ADDRESS = "GABC1234567890STELAR";

describe("StellarConnectionStatus", () => {
  describe("connection lifecycle states", () => {
    it("renders initial connecting state upon mounting", () => {
      render(<StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />);

      const statusEl = screen.getByRole("status");
      expect(statusEl).toBeTruthy();
      expect(statusEl.getAttribute("data-status")).toBe("connecting");
      expect(statusEl.textContent).toContain("Connecting");
      expect(statusEl.getAttribute("aria-label")).toBe("Stellar connection Connecting");
      expect(statusEl.getAttribute("aria-live")).toBe("polite");
      expect(statusEl.className).toContain("stellar-connection-status");
      expect(statusEl.className).toContain("stellar-connection-status--connecting");

      const dot = statusEl.querySelector(".stellar-connection-status__dot");
      expect(dot).toBeTruthy();
      expect(dot?.getAttribute("aria-hidden")).toBe("true");

      const label = statusEl.querySelector(".stellar-connection-status__label");
      expect(label).toBeTruthy();
      expect(label?.textContent).toBe("Connecting");
    });

    it("transitions to connected state when connection opens", () => {
      render(<StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />);

      const source = MockEventSource.instances[0];
      expect(source).toBeDefined();

      act(() => {
        source.onopen?.();
      });

      const statusEl = screen.getByRole("status");
      expect(statusEl.getAttribute("data-status")).toBe("connected");
      expect(statusEl.textContent).toContain("Connected");
      expect(statusEl.getAttribute("aria-label")).toBe("Stellar connection Connected");
      expect(statusEl.className).toContain("stellar-connection-status--connected");
      expect(statusEl.className).not.toContain("stellar-connection-status--connecting");
    });

    it("transitions to error state when connection encounters an error", () => {
      render(<StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />);

      const source = MockEventSource.instances[0];
      expect(source).toBeDefined();

      act(() => {
        source.onerror?.();
      });

      const statusEl = screen.getByRole("status");
      expect(statusEl.getAttribute("data-status")).toBe("error");
      expect(statusEl.textContent).toContain("Retrying");
      expect(statusEl.getAttribute("aria-label")).toBe("Stellar connection Retrying");
      expect(statusEl.className).toContain("stellar-connection-status--error");
    });

    it("transitions from error back to connected on reconnection", () => {
      render(<StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />);

      const source = MockEventSource.instances[0];

      act(() => {
        source.onerror?.();
      });
      expect(screen.getByRole("status").getAttribute("data-status")).toBe("error");

      act(() => {
        source.onopen?.();
      });
      expect(screen.getByRole("status").getAttribute("data-status")).toBe("connected");
      expect(screen.getByRole("status").textContent).toContain("Connected");
    });

    it("unsubscribes and closes connection when component unmounts", () => {
      const { unmount } = render(<StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />);

      const source = MockEventSource.instances[0];
      expect(source.closed).toBe(false);

      unmount();

      expect(source.closed).toBe(true);
    });

    it("exercises onEvent and onParseError handlers without errors", () => {
      render(<StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />);

      const source = MockEventSource.instances[0];

      act(() => {
        source.onopen?.();
      });

      // Emitting valid event triggers onEvent
      act(() => {
        source.emit({ type: "payment", amount: "100" }, "evt-1");
      });

      // Emitting invalid JSON triggers onParseError
      act(() => {
        source.emitRaw("invalid-json{");
      });

      expect(screen.getByRole("status").getAttribute("data-status")).toBe("connected");
    });
  });

  describe("custom labels and aria-label", () => {
    it("supports complete custom labels for all states", () => {
      const customLabels = {
        connecting: "Establishing Link",
        connected: "Online",
        error: "Disconnected",
      };

      render(
        <StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} labels={customLabels} />,
      );

      const statusEl = screen.getByRole("status");
      expect(statusEl.textContent).toContain("Establishing Link");
      expect(statusEl.getAttribute("aria-label")).toBe("Stellar connection Establishing Link");

      const source = MockEventSource.instances[0];

      act(() => {
        source.onopen?.();
      });
      expect(statusEl.textContent).toContain("Online");
      expect(statusEl.getAttribute("aria-label")).toBe("Stellar connection Online");

      act(() => {
        source.onerror?.();
      });
      expect(statusEl.textContent).toContain("Disconnected");
      expect(statusEl.getAttribute("aria-label")).toBe("Stellar connection Disconnected");
    });

    it("falls back to default labels when partial labels are passed", () => {
      render(
        <StellarConnectionStatus
          serverUrl={SERVER}
          address={ADDRESS}
          labels={{ connected: "Synchronized" }}
        />,
      );

      const statusEl = screen.getByRole("status");
      // connecting is omitted, falls back to default
      expect(statusEl.textContent).toContain("Connecting");

      const source = MockEventSource.instances[0];
      act(() => {
        source.onopen?.();
      });
      expect(statusEl.textContent).toContain("Synchronized");

      act(() => {
        source.onerror?.();
      });
      // error is omitted, falls back to default
      expect(statusEl.textContent).toContain("Retrying");
    });

    it("uses custom aria-label override when provided", () => {
      render(
        <StellarConnectionStatus
          serverUrl={SERVER}
          address={ADDRESS}
          aria-label="Custom status reader"
        />,
      );

      const statusEl = screen.getByRole("status");
      expect(statusEl.getAttribute("aria-label")).toBe("Custom status reader");

      const source = MockEventSource.instances[0];
      act(() => {
        source.onopen?.();
      });
      expect(statusEl.getAttribute("aria-label")).toBe("Custom status reader");
    });
  });

  describe("extra span props forwarding", () => {
    it("forwards native span attributes, custom className, style, role and event handlers", () => {
      const handleClick = vi.fn();

      render(
        <StellarConnectionStatus
          serverUrl={SERVER}
          address={ADDRESS}
          id="custom-status-id"
          data-testid="connection-status-test"
          title="Connection tooltip"
          tabIndex={0}
          role="region"
          aria-live="assertive"
          className="user-added-class"
          style={{ marginTop: "12px" }}
          onClick={handleClick}
        />,
      );

      const statusEl = screen.getByTestId("connection-status-test");
      expect(statusEl.id).toBe("custom-status-id");
      expect(statusEl.title).toBe("Connection tooltip");
      expect(statusEl.tabIndex).toBe(0);
      expect(statusEl.getAttribute("role")).toBe("region");
      expect(statusEl.getAttribute("aria-live")).toBe("assertive");
      expect(statusEl.className).toContain("user-added-class");
      expect(statusEl.className).toContain("stellar-connection-status");
      expect(statusEl.style.marginTop).toBe("12px");
      expect(statusEl.style.display).toBe("inline-flex");

      fireEvent.click(statusEl);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("token and prop updates", () => {
    it("forwards token query parameter to connection url", () => {
      render(
        <StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} token="test-secret-token" />,
      );

      expect(MockEventSource.instances.length).toBe(1);
      expect(MockEventSource.instances[0].url).toContain("token=test-secret-token");
    });

    it("resubscribes when connection coordinates change", () => {
      const { rerender } = render(<StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />);

      expect(MockEventSource.instances.length).toBe(1);
      const firstSource = MockEventSource.instances[0];

      rerender(<StellarConnectionStatus serverUrl={SERVER} address="GNEWADDRESS999" />);

      expect(firstSource.closed).toBe(true);
      expect(MockEventSource.instances.length).toBe(2);
      expect(MockEventSource.instances[1].url).toContain("GNEWADDRESS999");
    });
  });

  describe("missing serverUrl or address guard", () => {
    it("sets status to error immediately if serverUrl is empty", () => {
      render(<StellarConnectionStatus serverUrl="" address={ADDRESS} />);

      expect(MockEventSource.instances.length).toBe(0);
      const statusEl = screen.getByRole("status");
      expect(statusEl.getAttribute("data-status")).toBe("error");
      expect(statusEl.textContent).toContain("Retrying");
    });

    it("sets status to error immediately if address is empty", () => {
      render(<StellarConnectionStatus serverUrl={SERVER} address="" />);

      expect(MockEventSource.instances.length).toBe(0);
      const statusEl = screen.getByRole("status");
      expect(statusEl.getAttribute("data-status")).toBe("error");
      expect(statusEl.textContent).toContain("Retrying");
    });

    it("recovers from missing coordinate to active connection when props change", () => {
      const { rerender } = render(<StellarConnectionStatus serverUrl="" address={ADDRESS} />);

      expect(MockEventSource.instances.length).toBe(0);
      expect(screen.getByRole("status").getAttribute("data-status")).toBe("error");

      rerender(<StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />);

      expect(MockEventSource.instances.length).toBe(1);
      expect(screen.getByRole("status").getAttribute("data-status")).toBe("connecting");
    });
  });

  describe("SSR behavior", () => {
    it("renders nothing during SSR because StellarEventBoundary has fallback null", () => {
      const html = renderToStaticMarkup(
        <StellarConnectionStatus serverUrl={SERVER} address={ADDRESS} />,
      );

      expect(html).toBe("");
    });
  });
});
