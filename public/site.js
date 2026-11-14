(() => {
  const releaseLabel = document.querySelector("#release-label");
  const cards = [...document.querySelectorAll(".download-card[data-asset]")];
  const bytes = (size) => size < 1024 * 1024 ? Math.round(size / 1024) + " KB" : (size / 1024 / 1024).toFixed(1) + " MB";
  fetch("/api/releases", { cache: "no-store" }).then((response) => response.json()).then((release) => {
    if (!release.available) {
      releaseLabel.innerHTML = "<i></i> DOWNLOADS COMING SOON";
      return;
    }
    releaseLabel.innerHTML = "<i></i> LATEST RELEASE · " + release.version;
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    for (const card of cards) {
      const asset = assets.get(card.dataset.asset);
      const link = card.querySelector(".download-button");
      const status = card.querySelector(".asset-status");
      if (!asset) {
        status.textContent = "Not included in this release";
        continue;
      }
      link.href = asset.url;
      link.setAttribute("download", "");
      link.classList.add("ready");
      status.textContent = bytes(asset.size);
    }
  }).catch(() => { releaseLabel.innerHTML = "<i></i> DOWNLOADS TEMPORARILY UNAVAILABLE"; });
})();
