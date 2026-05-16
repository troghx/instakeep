import { prepareDownloadZipRequest, streamDownloadZipRequest } from "./_shared/media.mjs";

export default async (request) => {
  if (request.method === "POST") return prepareDownloadZipRequest(request);
  return streamDownloadZipRequest(request);
};

export const config = {
  path: "/api/download-zip",
};
