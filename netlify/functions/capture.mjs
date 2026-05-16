import { handleCaptureRequest } from "./_shared/media.mjs";

export default async (request) => handleCaptureRequest(request);

export const config = {
  path: "/api/capture",
};
