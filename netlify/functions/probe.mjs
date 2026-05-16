import { handleProbeRequest } from "./_shared/media.mjs";

export default async (request) => handleProbeRequest(request);

export const config = {
  path: "/api/probe",
};
