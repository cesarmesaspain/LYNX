import { describe, expect, it } from "vitest";
import { settingsTabScript } from "../../../src/server/dashboard/scripts/settings-tab.js";

describe("settings secret hydration", () => {
  it("shows configured secret keys as placeholders without placing masked values in fields", () => {
    const script = settingsTabScript(false, {
      save: "Save",
      saved: "Saved",
      saving: "Saving...",
      loaded: "(configured)",
      agentResponseSaved: "Preference saved",
    });

    expect(script).toContain('e.value="";e.placeholder="(configured)"');
    expect(script).toContain('k.value="";k.placeholder="(configured)"');
    expect(script).not.toContain("e.value=k.deepseek");
    expect(script).not.toContain("k.value=k.vps_key");
    expect(script).toContain("cfgMcpToolProfile");
    expect(script).toContain("cfgAvoidedInputPrice");
  });
});
