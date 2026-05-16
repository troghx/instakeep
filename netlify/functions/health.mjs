import { jsonResponse } from "./_shared/media.mjs";

export default async () => jsonResponse(200, { ok: true, platform: "netlify" });

export const config = {
  path: "/api/health",
};
