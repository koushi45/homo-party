const API_BASE = "https://rimworld-inm.duckdns.org/api/watch-party";

async function getSession() {
  const { session = null } = await chrome.storage.local.get("session");
  return session;
}

async function setSession(session) {
  await chrome.storage.local.set({ session });
}

async function setSessionRole(session, isHost) {
  if (session.isHost === isHost) return session;
  const nextSession = { ...session, isHost };
  await setSession(nextSession);
  await broadcast({ type: "SESSION_CHANGED", session: nextSession });
  return nextSession;
}

async function request(path = "", options = {}, authenticated = true) {
  const { watchPartyToken } = await chrome.storage.local.get("watchPartyToken");
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(authenticated && watchPartyToken ? { Authorization: `Bearer ${watchPartyToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "同期サーバーに接続できません。");
    error.status = response.status;
    throw error;
  }
  return body;
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message)));
}

async function isActiveTab(tabId) {
  if (!tabId) return false;
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab?.id === tabId;
}

async function leaveCurrentRoom() {
  const session = await getSession();
  if (!session) return;
  await request(`/${session.roomId}/leave`, { method: "POST" }).catch(() => null);
  await setSession(null);
  await broadcast({ type: "SESSION_CHANGED", session: null });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "GET_SESSION") {
      let session = await getSession();
      if (session && typeof session.isHost !== "boolean") {
        const result = await request(`/${session.roomId}`);
        session = await setSessionRole(session, Boolean(result.room?.isHost));
      }
      return { session };
    }

    if (message.type === "START_PAIRING") {
      const pairing = await request("/pairing", { method: "POST" }, false);
      await chrome.storage.local.set({ watchPartyToken: pairing.token });
      return pairing;
    }

    if (message.type === "LIST_ROOMS") {
      const result = await request();
      let session = await getSession();
      let currentRoom = null;
      if (session) {
        try {
          currentRoom = (await request(`/${session.roomId}`)).room;
          if (typeof currentRoom?.isHost === "boolean") {
            session = await setSessionRole(session, currentRoom.isHost);
          }
        } catch (error) {
          if (error.status === 404 || error.status === 403) await setSession(null);
          else throw error;
        }
      }
      return { ...result, session: currentRoom ? session : null, currentRoom };
    }

    if (message.type === "CREATE_ROOM") {
      await leaveCurrentRoom();
      const result = await request("", { method: "POST", body: JSON.stringify(message.state) });
      const session = { roomId: result.room.id, isHost: Boolean(result.room?.isHost) };
      await setSession(session);
      await broadcast({ type: "SESSION_CHANGED", session });
      return { session, ...result };
    }

    if (message.type === "JOIN_ROOM") {
      await leaveCurrentRoom();
      const roomId = String(message.roomId || "").trim().toUpperCase();
      const result = await request(`/${roomId}`, { method: "POST" });
      const session = { roomId, isHost: Boolean(result.room?.isHost) };
      await setSession(session);
      await broadcast({ type: "SESSION_CHANGED", session });
      return { session, ...result };
    }

    if (message.type === "LEAVE_ROOM") {
      await leaveCurrentRoom();
      return { session: null };
    }

    const session = await getSession();
    if (!session) return { session: null };

    if (message.type === "POLL") {
      if (session.isHost) return { ignored: true };
      const result = await request(`/${session.roomId}`);
      if (typeof result.room?.isHost === "boolean") await setSessionRole(session, result.room.isHost);
      return result;
    }
    if (message.type === "UPDATE_STATE") {
      if (!session.isHost) return { ignored: true };
      if (!await isActiveTab(sender.tab?.id)) return { ignored: true };
      return await request(`/${session.roomId}`, { method: "PUT", body: JSON.stringify(message.state) });
    }
    if (message.type === "DELETE_ROOM") {
      const result = await request(`/${session.roomId}`, { method: "DELETE" });
      await setSession(null);
      await broadcast({ type: "SESSION_CHANGED", session: null });
      return result;
    }
    if (message.type === "TRANSFER_HOST") {
      const result = await request(`/${session.roomId}/host`, {
        method: "PUT",
        body: JSON.stringify({ userId: message.userId }),
      });
      await setSessionRole(session, Boolean(result.room?.isHost));
      return result;
    }
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message, status: error.status }));
  return true;
});
