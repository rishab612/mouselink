(() => {
  const body = document.body;
  const forced = new URLSearchParams(location.search).get("view");
  const wantsRemote = forced === "remote" || location.pathname === "/remote" ||
    (forced !== "host" && (navigator.maxTouchPoints > 0 || matchMedia("(max-width: 900px)").matches));
  body.dataset.mode = wantsRemote ? "remote" : "host";

  const $ = (selector) => document.querySelector(selector);
  const state = {
    socket: null, connected: false, pointerSpeed: Number(localStorage.getItem("mouselink-speed") || 1.2),
    scrollMode: false, points: new Map(), hadMultitouch: false,
    heldPointers: new Map(),
  };

  function setRemoteStatus(connected, label = "NOT CONNECTED") {
    state.connected = connected;
    const status = $("#remote-status");
    status.classList.toggle("is-live", connected);
    $("#remote-status-text").textContent = label;
    $("#pair-view").hidden = connected;
    $("#control-view").hidden = !connected;
  }

  function send(message) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN && state.connected) {
      state.socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function showError(message) {
    $("#connect-error").textContent = message;
  }

  function toast(message) {
    const element = $("#remote-toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove("show"), 1800);
  }

  function disconnect(showMessage = false) {
    if (state.socket) {
      try { state.socket.close(1000, "User disconnected"); } catch (_) { /* already closed */ }
    }
    state.socket = null;
    state.connected = false;
    state.points.clear();
    state.heldPointers.clear();
    setRemoteStatus(false);
    if (showMessage) showError("Disconnected from the desktop.");
  }

  function connect() {
    const pin = $("#pin-input").value.replace(/\D/g, "").slice(0, 6);
    if (pin.length !== 6) {
      showError("Enter the six-digit PIN shown on your computer.");
      $("#pin-input").focus();
      return;
    }
    if (state.socket) state.socket.close();
    showError("");
    $("#connect-button").disabled = true;
    $("#connect-button span:first-child").textContent = "Connecting…";
    setRemoteStatus(false, "CONNECTING");
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    state.socket = socket;
    let sentAuth = false;
    let authRejected = false;
    const timeout = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN && state.socket === socket) {
        socket.close();
        showError("Could not reach the desktop. Check the address and try again.");
        setRemoteStatus(false);
      }
    }, 9000);

    socket.onopen = () => {
      clearTimeout(timeout);
      if (state.socket !== socket) return;
      sentAuth = true;
      socket.send(JSON.stringify({ t: "auth", pin }));
    };
    socket.onmessage = (event) => {
      if (state.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.t === "auth") {
        if (message.ok) {
          state.connected = true;
          setRemoteStatus(true, "CONNECTED");
          $("#connected-host").textContent = location.hostname || "Your desktop";
          $("#pin-input").value = "";
          showError("");
          toast("Connected. Your touchpad is ready.");
        } else {
          authRejected = true;
          showError(message.reason || "Pairing failed. Check the PIN and try again.");
          state.connected = false;
          socket.close();
          setRemoteStatus(false);
        }
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      if (state.socket !== socket) return;
      showError("Could not reach the desktop. Check the local network and try again.");
      setRemoteStatus(false);
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      if (state.socket === socket) {
        const wasConnected = state.connected;
        state.socket = null;
        state.connected = false;
        setRemoteStatus(false);
        if (wasConnected || (sentAuth && !authRejected)) showError("Connection closed. Reconnect using the PIN on your computer.");
        $("#connect-button").disabled = false;
        $("#connect-button span:first-child").textContent = "Connect to desktop";
      }
    };
  }

  if (!wantsRemote) {
    async function loadHostStatus() {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        const info = await response.json();
        $("#host-name").textContent = info.name || "This computer";
        $("#platform-name").textContent = info.platform || "Desktop host";
        const select = $("#host-address-select");
        const addresses = Array.isArray(info.ips) ? info.ips : [];
        const currentHost = location.hostname && location.hostname !== "localhost" && location.hostname !== "127.0.0.1"
          ? location.hostname : null;
        const preferred = currentHost && addresses.includes(currentHost) ? currentHost : addresses[0];
        select.replaceChildren();
        addresses.forEach((address) => {
          const option = document.createElement("option");
          option.value = address;
          option.textContent = address;
          select.append(option);
        });
        if (addresses.length > 1) select.hidden = false;
        if (preferred) select.value = preferred;
        const updateHostAddress = () => {
          const targetIp = select.value || preferred || "your-computer-ip";
          $("#host-url").textContent = `http://${targetIp}:${info.port}`;
        };
        updateHostAddress();
        select.onchange = updateHostAddress;
        if (info.pin) $("#pin-display").innerHTML = [...info.pin].map((digit) => `<span>${digit}</span>`).join("");
        else $("#pin-display").innerHTML = "<span>Open this page on the desktop itself</span>";
        $("#session-state").textContent = info.connected ? "Phone connected" : "Waiting for a phone";
        $("#session-led").classList.toggle("is-live", !!info.connected);
        $("#connection-count").textContent = info.connected ? "1 device" : "0 devices";
        const remote = info.remote || { configured: false };
        $("#remote-session-details").hidden = !remote.configured;
        if (remote.configured) {
          $("#remote-session-code").textContent = remote.code || "────────────";
          $("#remote-session-pin").textContent = remote.pin || "──────";
          $("#remote-session-link").href = remote.url || "#";
          const relayReady = !!remote.ready;
          $("#remote-session-dot").classList.toggle("is-live", relayReady);
          $("#remote-session-state").textContent = remote.phoneConnected ? "Phone connected" :
            (relayReady ? "Relay ready · waiting for your phone" : (remote.error || "Connecting to relay…"));
          if (!$("#relay-url-input").value && remote.siteUrl) $("#relay-url-input").value = remote.siteUrl;
        }
      } catch (_) {
        $("#host-name").textContent = "Desktop host unavailable";
      }
    }
    loadHostStatus();
    state.hostPoll = setInterval(loadHostStatus, 1800);
    $("#relay-url-input").value = localStorage.getItem("mouselink-site-url") || "https://mouselink-ecru.vercel.app";
    $("#remote-start-button").addEventListener("click", async () => {
      const siteUrl = $("#relay-url-input").value.trim().replace(/\/+$/, "");
      $("#remote-setup-error").textContent = "";
      if (!siteUrl) {
        $("#remote-setup-error").textContent = "Paste the public HTTPS website URL first.";
        return;
      }
      const button = $("#remote-start-button");
      button.disabled = true;
      button.firstChild.textContent = "Connecting… ";
      try {
        const response = await fetch("/api/remote/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteUrl }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not start the remote session.");
        localStorage.setItem("mouselink-site-url", siteUrl);
        await loadHostStatus();
      } catch (error) {
        $("#remote-setup-error").textContent = error.message || "Could not start the remote session.";
      } finally {
        button.disabled = false;
        button.innerHTML = "Start remote session <span>↗</span>";
      }
    });
    $("#open-remote").addEventListener("click", () => { location.href = "/remote"; });
    $("#copy-url").addEventListener("click", async (event) => {
      try {
        await navigator.clipboard.writeText($("#host-url").textContent);
        event.currentTarget.textContent = "COPIED";
        setTimeout(() => { event.currentTarget.textContent = "COPY"; }, 1400);
      } catch (_) {
        event.currentTarget.textContent = "SELECT URL";
      }
    });
  }

  if (wantsRemote) {
    $("#connect-button").addEventListener("click", connect);
    $("#pin-input").addEventListener("input", (event) => {
      event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "").slice(0, 6);
      showError("");
    });
    $("#pin-input").addEventListener("keydown", (event) => { if (event.key === "Enter") connect(); });
    $("#disconnect-button").addEventListener("click", () => disconnect());

    const speedSlider = $("#sensitivity");
    speedSlider.value = String(state.pointerSpeed);
    function updateSpeed() {
      state.pointerSpeed = Number(speedSlider.value);
      localStorage.setItem("mouselink-speed", String(state.pointerSpeed));
      $("#speed-number").textContent = `${state.pointerSpeed.toFixed(1)}×`;
      $("#sensitivity-value").textContent = `SPEED ${state.pointerSpeed.toFixed(1)}×`;
    }
    speedSlider.addEventListener("input", updateSpeed);
    updateSpeed();

    $("#scroll-toggle").addEventListener("click", () => {
      state.scrollMode = !state.scrollMode;
      $("#scroll-toggle").classList.toggle("is-active", state.scrollMode);
      $("#scroll-toggle").setAttribute("aria-pressed", String(state.scrollMode));
      $("#touchpad").classList.toggle("scroll-mode", state.scrollMode);
      toast(state.scrollMode ? "Scroll mode on. Slide to scroll." : "Pointer mode on.");
    });
    $("#keyboard-toggle").addEventListener("click", () => {
      const panel = $("#keyboard-panel");
      panel.hidden = !panel.hidden;
      $("#keyboard-toggle").classList.toggle("is-active", !panel.hidden);
      if (!panel.hidden) $("#keyboard-input").focus();
    });
    $("#send-text").addEventListener("click", () => {
      const field = $("#keyboard-input");
      if (!field.value) return;
      if (send({ t: "text", value: field.value.slice(0, 100) })) {
        field.value = "";
        toast("Text sent to desktop.");
      }
    });
    $("#keyboard-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        $("#send-text").click();
        send({ t: "key", key: "ENTER" });
      }
    });
    document.querySelectorAll(".special-keys button").forEach((button) => {
      button.addEventListener("click", () => send({ t: "key", key: button.dataset.key }));
    });

    function buttonPress(buttonName, element) {
      if (!send({ t: "button", button: buttonName, down: true })) return;
      element.classList.add("is-pressed");
      state.pressedButtons ??= new Set();
      state.pressedButtons.add(buttonName);
    }
    function buttonRelease(buttonName, element) {
      if (!state.pressedButtons || !state.pressedButtons.has(buttonName)) return;
      send({ t: "button", button: buttonName, down: false });
      state.pressedButtons.delete(buttonName);
      element.classList.remove("is-pressed");
    }
    [["left-click", "left"], ["right-click", "right"], ["middle-click", "middle"]].forEach(([id, name]) => {
      const element = $(`#${id}`);
      element.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        element.setPointerCapture(event.pointerId);
        buttonPress(name, element);
        state.heldPointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: name, element });
      });
      const release = (event) => {
        const held = state.heldPointers.get(event.pointerId);
        if (!held) return;
        state.heldPointers.delete(event.pointerId);
        buttonRelease(name, element);
      };
      element.addEventListener("pointerup", release);
      element.addEventListener("pointercancel", release);
      element.addEventListener("lostpointercapture", release);
    });

    const pad = $("#touchpad");
    pad.addEventListener("contextmenu", (event) => event.preventDefault());
    pad.addEventListener("pointerdown", (event) => {
      if (!state.connected) return;
      event.preventDefault();
      pad.setPointerCapture(event.pointerId);
      state.points.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, at: performance.now(), moved: false });
      if (state.points.size > 1) state.hadMultitouch = true;
    });
    pad.addEventListener("pointermove", (event) => {
      const point = state.points.get(event.pointerId);
      if (!point) return;
      const dx = event.clientX - point.x;
      const dy = event.clientY - point.y;
      point.x = event.clientX;
      point.y = event.clientY;
      if (Math.abs(event.clientX - point.startX) + Math.abs(event.clientY - point.startY) > 8) point.moved = true;
      if (state.points.size >= 2 || state.scrollMode) {
        state.hadMultitouch = state.points.size >= 2 || state.hadMultitouch;
        const amount = -Math.round(dy / 22);
        if (amount) send({ t: "scroll", amount });
      } else if (state.heldPointers.size === 0) {
        const scale = state.pointerSpeed * 1.9;
        send({ t: "move", x: dx * scale, y: dy * scale });
      }
    });
    const finishPadPointer = (event) => {
      const point = state.points.get(event.pointerId);
      if (!point) return;
      state.points.delete(event.pointerId);
      if (state.points.size === 0) {
        if (!state.hadMultitouch && !point.moved && performance.now() - point.at < 320) {
          send({ t: "button", button: "left", down: true });
          send({ t: "button", button: "left", down: false });
        }
        state.hadMultitouch = false;
      }
    };
    pad.addEventListener("pointerup", finishPadPointer);
    pad.addEventListener("pointercancel", finishPadPointer);

    document.addEventListener("pointermove", (event) => {
      const held = state.heldPointers.get(event.pointerId);
      if (!held || !state.connected) return;
      const dx = event.clientX - held.x;
      const dy = event.clientY - held.y;
      held.x = event.clientX;
      held.y = event.clientY;
      if (dx || dy) send({ t: "move", x: dx * state.pointerSpeed * 1.9, y: dy * state.pointerSpeed * 1.9 });
    });

    window.addEventListener("blur", () => {
      if (state.pressedButtons) {
        for (const button of state.pressedButtons) send({ t: "button", button, down: false });
        state.pressedButtons.clear();
      }
      state.heldPointers.clear();
      state.points.clear();
    });
    window.addEventListener("pagehide", () => { if (state.socket) state.socket.close(); });
  }

  if ("serviceWorker" in navigator && location.hostname === "localhost") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
