const $ = (selector) => document.querySelector(selector);
let tabId = null;
let localState = null;

async function message(payload) {
  const result = await chrome.runtime.sendMessage(payload);
  if (result?.error) throw new Error(result.error);
  return result;
}

function render(session) {
  $("#disconnected").hidden = Boolean(session);
  $("#connected").hidden = !session;
  $("#currentRoom").textContent = session?.roomId || "";
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  try {
    const page = await chrome.tabs.sendMessage(tabId, { type: "GET_LOCAL_STATE" });
    localState = page.state;
    $("#site").textContent = page.supported ? "動画を検出しました" : "このページでは動画を検出できません";
    $("#create").disabled = !page.supported;
  } catch {
    $("#create").disabled = true;
  }
  render((await message({ type: "GET_SESSION" })).session);
}

$("#create").addEventListener("click", async () => {
  try {
    $("#status").textContent = "作成中...";
    const result = await message({ type: "CREATE_ROOM", state: localState });
    render(result.session);
    $("#status").textContent = "ルームIDを一緒に見る人へ共有してください";
  } catch (error) {
    $("#status").textContent = error.message;
  }
});

$("#join").addEventListener("click", async () => {
  try {
    $("#status").textContent = "参加中...";
    const result = await message({ type: "JOIN_ROOM", roomId: $("#roomId").value });
    render(result.session);
    $("#status").textContent = result.state.mediaKey === localState?.mediaKey
      ? "同期を開始しました"
      : "参加しました。同じ動画を開くと同期します";
  } catch (error) {
    $("#status").textContent = error.message;
  }
});

$("#leave").addEventListener("click", async () => {
  render((await message({ type: "LEAVE_ROOM" })).session);
  $("#status").textContent = "退出しました";
});

init();
