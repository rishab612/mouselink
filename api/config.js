export default function handler(request, response) {
  const configured = process.env.MOUSELINK_RELAY_URL;
  if (!configured) {
    response.setHeader("Cache-Control", "no-store");
    return response.status(503).json({ error: "MouseLink remote relay has not been configured." });
  }

  try {
    const relay = new URL(configured);
    if (relay.protocol !== "https:" || relay.username || relay.password || relay.pathname !== "/" || relay.search || relay.hash) {
      throw new Error("Invalid relay origin");
    }
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({ relayOrigin: relay.origin });
  } catch {
    response.setHeader("Cache-Control", "no-store");
    return response.status(500).json({ error: "MouseLink relay configuration is invalid." });
  }
}
