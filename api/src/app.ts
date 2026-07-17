import Fastify, { type FastifyInstance } from "fastify";
import { intelligenceRoutes } from "./routes/intelligence.js";
import { licenseRoutes } from "./routes/license.js";
import { versionRoutes } from "./routes/version.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { stripeRoutes } from "./routes/stripe.js";
import { teamRoutes } from "./routes/team.js";

export function parseJsonWithRawBody(body: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  Object.defineProperty(parsed, "__rawBody", {
    value: body,
    enumerable: false,
  });
  return parsed;
}

export function createApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info" },
  });

  // Stripe signs the exact request bytes. Keep them attached to parsed JSON so
  // the webhook can verify the signature without weakening JSON handling elsewhere.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      try {
        done(
          null,
          parseJsonWithRawBody(
            Buffer.isBuffer(body) ? body : Buffer.from(body),
          ),
        );
      } catch {
        done(new Error("Invalid JSON body"));
      }
    },
  );

  intelligenceRoutes(app);
  licenseRoutes(app);
  versionRoutes(app);
  telemetryRoutes(app);
  stripeRoutes(app);
  teamRoutes(app);
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));
  return app;
}
