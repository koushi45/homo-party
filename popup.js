const $ = (selector) => document.querySelector(selector);
let localState = null;
let session = null;
let roomDetails = null;

async function message(payload) {
  const result = await chrome.runtime.sendMessage(payload);
  if (result?.error) {
    const error = new Error(result.error);
    error.status = result.status;
    throw error;
  }
  return result;
}

function setStatus(text = "") {
  $("#status").textContent = text;
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $("#roomsPanel").hidden = name !== "rooms";
  $("#currentPanel").hidden = name !== "current";
}

function renderRooms(rooms) {
  $("#noRooms").hidden = rooms.length > 0;
  $("#rooms").replaceChildren(...rooms.map((room) => {
    const item = document.createElement("article");
    item.className = `room${room.id === session?.roomId ? " current" : ""}`;
    const info = document.createElement("div");
    const id = document.createElement("strong");
    id.className = "room-id";
    id.textContent = room.id;
    const title = document.createElement("p");
    title.className = "video-title";
    title.title = room.title || "動画タイトルなし";
    title.textContent = room.title || "動画タイトルなし";
    info.append(id, title);
    const join = document.createElement("button");
    join.textContent = room.id === session?.roomId ? "接続中" : "接続";
    join.disabled = room.id === session?.roomId;
    join.addEventListener("click", () => joinRoom(room.id));
    item.append(info, join);
    return item;
  }));
}

function renderCurrent(room) {
  roomDetails = room;
  const connected = Boolean(room);
  $("#connectedDot").textContent = connected ? " " : "";
  $("#notConnected").hidden = connected;
  $("#currentRoomCard").hidden = !connected;
  if (!room) return;

  $("#currentRoom").textContent = room.id;
  $("#currentTitle").textContent = room.title || "動画タイトルなし";
  $("#currentTitle").title = room.title || "";
  $("#deleteRoom").hidden = !room.isHost;
  $("#participants").replaceChildren(...room.participants.map((participant) => {
    const item = document.createElement("div");
    item.className = "participant";
    const name = document.createElement("span");
    name.className = "participant-name";
    name.textContent = participant.accountName;
    if (participant.isHost) {
      const badge = document.createElement("span");
      badge.className = "host-badge";
      badge.textContent = "ホスト";
      name.append(badge);
    }
    item.append(name);
    if (room.isHost && !participant.isHost) {
      const transfer = document.createElement("button");
      transfer.className = "transfer";
      transfer.textContent = "ホスト交代";
      transfer.addEventListener("click", () => transferHost(participant.userId));
      item.append(transfer);
    }
    return item;
  }));
}

async function refresh() {
  try {
    const result = await message({ type: "LIST_ROOMS" });
    session = result.session;
    $("#loginRequired").hidden = true;
    $("#app").hidden = false;
    $("#account").textContent = result.user.accountName;
    renderRooms(result.rooms);
    renderCurrent(result.currentRoom);
  } catch (error) {
    if (error.status === 401) {
      $("#loginRequired").hidden = false;
      $("#app").hidden = true;
      return;
    }
    setStatus(error.message);
  }
}

async function joinRoom(roomId) {
  try {
    setStatus("接続中...");
    const result = await message({ type: "JOIN_ROOM", roomId });
    session = result.session;
    renderCurrent(result.room);
    showTab("current");
    setStatus(result.state.mediaKey === localState?.mediaKey
      ? "同期を開始しました。"
      : "接続しました。同じ動画を開くと同期します。");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
}

async function transferHost(userId) {
  try {
    renderCurrent((await message({ type: "TRANSFER_HOST", userId })).room);
    setStatus("ホストを交代しました。");
  } catch (error) {
    setStatus(error.message);
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const page = await chrome.tabs.sendMessage(tab?.id, { type: "GET_LOCAL_STATE" });
    localState = page.state;
    $("#site").textContent = page.supported ? page.state.title : "このページでは動画を検出できません。";
    $("#create").disabled = !page.supported;
  } catch {
    $("#create").disabled = true;
  }
  await refresh();
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
$("#refresh").addEventListener("click", refresh);
$("#openLogin").addEventListener("click", async () => {
  try {
    const pairing = await message({ type: "START_PAIRING" });
    $("#pairingCode").textContent = pairing.pairingCode;
    $("#checkPairing").hidden = false;
    $("#openLogin").textContent = "新しい連携コードを発行";
    await chrome.tabs.create({ url: `https://rimworld-inm.duckdns.org/homo-party?code=${pairing.pairingCode}` });
  } catch (error) {
    setStatus(error.message);
  }
});
$("#checkPairing").addEventListener("click", refresh);
$("#create").addEventListener("click", async () => {
  try {
    setStatus("ルームを作成中...");
    const result = await message({ type: "CREATE_ROOM", state: localState });
    session = result.session;
    renderCurrent(result.room);
    showTab("current");
    setStatus("ルームを作成しました。");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
});
$("#leave").addEventListener("click", async () => {
  try {
    await message({ type: "LEAVE_ROOM" });
    session = null;
    renderCurrent(null);
    setStatus("ルームから退出しました。");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
});
$("#deleteRoom").addEventListener("click", async () => {
  if (!roomDetails || !confirm("このルームを削除しますか？")) return;
  try {
    await message({ type: "DELETE_ROOM" });
    session = null;
    renderCurrent(null);
    showTab("rooms");
    setStatus("ルームを削除しました。");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
});

init();
