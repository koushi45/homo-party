const API_BASE = "https://rimworld-inm.duckdns.org/api/watch-party";

async function getSession() {
  const { session = null } = await chrome.storage.local.get("session");
  return session;
}

async function setSession(session) {
  await chrome.storage.local.set({ session });
}

async function request(path = "", options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "同期サーバーに接続できません");
  return body;
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message)));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "GET_SESSION") return { session: await getSession() };

    if (message.type === "CREATE_ROOM") {
      const result = await request("", {
        method: "POST",
        body: JSON.stringify(message.state),
      });
      const session = { roomId: result.roomId };
      await setSession(session);
      await broadcast({ type: "SESSION_CHANGED", session });
      return { session, state: result.state };
    }

    if (message.type === "JOIN_ROOM") {
      const roomId = String(message.roomId || "").trim().toUpperCase();
      const result = await request(`/${roomId}`);
      const session = { roomId };
      await setSession(session);
      await broadcast({ type: "SESSION_CHANGED", session });
      return { session, state: result.state };
    }

    if (message.type === "LEAVE_ROOM") {
      await setSession(null);
      await broadcast({ type: "SESSION_CHANGED", session: null });
      return { session: null };
    }

    const session = await getSession();
    if (!session) return { session: null };

    if (message.type === "POLL") {
      return await request(`/${session.roomId}`);
    }

    if (message.type === "UPDATE_STATE") {
      return await request(`/${session.roomId}`, {
        method: "PUT",
        body: JSON.stringify(message.state),
      });
    }
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});
