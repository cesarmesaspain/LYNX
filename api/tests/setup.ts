import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-api-test-"));
process.env.LYNX_API_DATA_DIR = dataDir;
process.env.LYNX_HOME = path.join(dataDir, "lynx-home");
process.env.NODE_ENV = "test";

process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
