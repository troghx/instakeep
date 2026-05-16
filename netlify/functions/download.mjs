import { handleDownloadRequest } from "./_shared/media.mjs";

export default async (request) => handleDownloadRequest(request);

export const config = {
  path: "/api/download",
};
