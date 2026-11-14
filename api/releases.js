export default async function handler(_request, response) {
  response.setHeader("Cache-Control", "public, max-age=60");
  try {
    const result = await fetch("https://api.github.com/repos/rishab612/mouselink/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "MouseLink-Downloads" },
    });
    if (!result.ok) {
      response.status(200).json({ available: false, reason: "No public release has been published yet." });
      return;
    }
    const release = await result.json();
    response.status(200).json({
      available: true,
      version: release.tag_name,
      releaseUrl: release.html_url,
      assets: (release.assets || []).map(({ name, size, browser_download_url }) => ({
        name,
        size,
        url: browser_download_url,
      })),
    });
  } catch {
    response.status(503).json({ available: false, reason: "Release information is temporarily unavailable." });
  }
}
