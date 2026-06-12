const API_BASE = "https://rimworld-inm.duckdns.org/api/watch-party";
const HEARTBEAT_INTERVAL_MS = 30_000;
let realtimeGeneration = 0;
let realtimeAbortController = null;
let heartbeatTimer = null;
let roomEtag = null;

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
  const { acceptNotModified = false, ...fetchOptions } = options;
  const { watchPartyToken } = await chrome.storage.local.get("watchPartyToken");
  const response = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      ...(authenticated && watchPartyToken ? { Authorization: `Bearer ${watchPartyToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (acceptNotModified && response.status === 304) {
    return {
      notModified: true,
      etag: response.headers.get("ETag"),
      serverNow: Number(response.headers.get("X-Server-Time")) || Date.now(),
    };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "同期サーバーに接続できません。");
    error.status = response.status;
    throw error;
  }
  return { ...body, etag: response.headers.get("ETag") };
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

async function handleRoomUpdate(payload) {
  if (payload.deleted) {
    await setSession(null);
    stopRealtime();
    await broadcast({ type: "SESSION_CHANGED", session: null });
    return;
  }
  if (!payload.room) return;
  let session = await getSession();
  if (!session || session.roomId !== payload.room.id) return;
  session = await setSessionRole(session, Boolean(payload.room.isHost));
  roomEtag = `"room-${payload.room.id}-${payload.room.state.revision}"`;
  await broadcast({ type: "ROOM_UPDATED", ...payload, session });
}

async function streamRoomEvents(session, generation) {
  const { watchPartyToken } = await chrome.storage.local.get("watchPartyToken");
  const controller = new AbortController();
  realtimeAbortController = controller;
  const response = await fetch(`${API_BASE}/${session.roomId}/events`, {
    headers: { Authorization: `Bearer ${watchPartyToken}` },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error("リアルタイム接続を開始できません。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (generation === realtimeGeneration) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split("\n\n");
    buffer = messages.pop() || "";
    for (const message of messages) {
      const data = message.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) await handleRoomUpdate(JSON.parse(data));
    }
  }
}

async function sendHeartbeat(session) {
  try {
    await request(`/${session.roomId}/heartbeat`, { method: "POST" });
  } catch (error) {
    if (error.status === 403 || error.status === 404) await handleRoomUpdate({ deleted: true });
  }
}

function stopRealtime() {
  realtimeGeneration += 1;
  realtimeAbortController?.abort();
  realtimeAbortController = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  roomEtag = null;
}

function startRealtime(session) {
  stopRealtime();
  if (!session) return;
  const generation = realtimeGeneration;
  void sendHeartbeat(session);
  heartbeatTimer = setInterval(() => void sendHeartbeat(session), HEARTBEAT_INTERVAL_MS);
  const connect = async () => {
    try {
      await streamRoomEvents(session, generation);
    } catch {
      // Conditional polling remains active while the event stream reconnects.
    }
    if (generation === realtimeGeneration) setTimeout(connect, 3_000);
  };
  void connect();
}

async function pollCurrentRoom(session) {
  const result = await request(`/${session.roomId}`, {
    acceptNotModified: true,
    headers: roomEtag ? { "If-None-Match": roomEtag } : {},
  });
  if (result.etag) roomEtag = result.etag;
  if (!result.notModified) await handleRoomUpdate(result);
  return result;
}

async function leaveCurrentRoom() {
  const session = await getSession();
  if (!session) return;
  await request(`/${session.roomId}/leave`, { method: "POST" }).catch(() => null);
  await setSession(null);
  stopRealtime();
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
      if (session && !heartbeatTimer) startRealtime(session);
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
          if (error.status === 404 || error.status === 403) {
            await setSession(null);
            stopRealtime();
          }
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
      startRealtime(session);
      await broadcast({ type: "SESSION_CHANGED", session });
      return { session, ...result };
    }

    if (message.type === "JOIN_ROOM") {
      await leaveCurrentRoom();
      const roomId = String(message.roomId || "").trim().toUpperCase();
      const result = await request(`/${roomId}`, { method: "POST" });
      const session = { roomId, isHost: Boolean(result.room?.isHost) };
      await setSession(session);
      startRealtime(session);
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
      return await pollCurrentRoom(session);
    }
    if (message.type === "UPDATE_STATE") {
      if (!session.isHost) return { ignored: true };
      if (!await isActiveTab(sender.tab?.id)) return { ignored: true };
      return await request(`/${session.roomId}`, { method: "PUT", body: JSON.stringify(message.state) });
    }
    if (message.type === "DELETE_ROOM") {
      const result = await request(`/${session.roomId}`, { method: "DELETE" });
      await setSession(null);
      stopRealtime();
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

getSession().then(startRealtime);
