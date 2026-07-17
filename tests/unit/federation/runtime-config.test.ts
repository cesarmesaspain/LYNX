import { afterEach, describe, expect, it } from "vitest";
import { configureFederationFromRuntime } from "../../../src/federation/runtime-config.js";
import {
  getFederatedConfig,
  clearFederatedConfig,
} from "../../../src/federation/handler-bridge.js";
import { LocalIndexProvider } from "../../../src/federation/providers.js";
import { HttpSharedIndexProvider } from "../../../src/federation/http-shared-provider.js";
import type { LynxRuntimeConfig } from "../../../src/config/runtime.js";

const baseConfig: LynxRuntimeConfig = {
  enabled: true,
  auto_index: true,
  auto_index_limit: 50_000,
  auto_watch: true,
  auto_dashboard: true,
  stale_threshold_hours: 24,
  lock_ttl_minutes: 5,
  locale: "en",
};

afterEach(() => {
  clearFederatedConfig();
});

describe("configureFederationFromRuntime", () => {
  it("clears federation when Team backend is disabled", () => {
    expect(
      configureFederationFromRuntime({
        ...baseConfig,
        team_backend: {
          enabled: false,
          base_url: "",
          timeout_ms: 2000,
        },
      }),
    ).toBe(false);
    expect(getFederatedConfig()).toBeNull();
  });

  it("installs the HTTP shared provider from normalized Team runtime config", () => {
    expect(
      configureFederationFromRuntime({
        ...baseConfig,
        team_backend: {
          enabled: true,
          base_url: "https://team.example.test",
          access_token: "team-token",
          timeout_ms: 750,
        },
      }),
    ).toBe(true);

    const config = getFederatedConfig();
    expect(config).not.toBeNull();
    expect(config?.teamName).toBe("team.example.test");
    expect(config?.localProvider).toBeInstanceOf(LocalIndexProvider);
    expect(config?.sharedProvider).toBeInstanceOf(HttpSharedIndexProvider);
    expect(config?.sharedTimeoutMs).toBe(750);
    expect(config?.authorizer.authorizeProject("any-project")).toEqual({
      allowed: true,
    });
  });
});
