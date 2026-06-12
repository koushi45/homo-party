let session = null;
let video = null;
let suppressUntil = 0;
let lastRevision = 0;
let pollTimer = null;
let videoObserver = null;
const SYNC_INTERVAL_MS = 3000;

function mediaKey() {
  const url = new URL(location.href);
  if (url.hostname.includes("youtube.com")) return `youtube:${url.searchParams.get("v") || url.pathname}`;
  if (url.hostname.includes("nicovideo.jp")) return `nicovideo:${url.pathname}`;
  return `primevideo:${url.pathname}`;
}

function localState() {
  return {
    mediaKey: mediaKey(),
    title: document.title.slice(0, 500),
    url: location.href.slice(0, 2000),
    currentTime: video?.currentTime || 0,
    paused: video?.paused ?? true,
    playbackRate: video?.playbackRate || 1,
  };
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

function reportState() {
  if (!session || !video || Date.now() < suppressUntil) return;
  return send({ type: "UPDATE_STATE", state: localState() });
}

async function applyState(state) {
  if (!video || state.revision <= lastRevision || state.mediaKey !== mediaKey()) return;
  lastRevision = state.revision;
  suppressUntil = Date.now() + 1200;

  const projectedTime = state.paused
    ? state.currentTime
    : state.currentTime + ((Date.now() - state.updatedAt) / 1000) * state.playbackRate;
  if (Math.abs(video.currentTime - projectedTime) > 1.2) video.currentTime = projectedTime;
  if (Math.abs(video.playbackRate - state.playbackRate) > 0.01) video.playbackRate = state.playbackRate;

  if (state.paused && !video.paused) video.pause();
  if (!state.paused && video.paused) {
    try {
      await video.play();
    } catch {
      // Browsers may require one user gesture before programmatic playback.
    }
  }
}

async function poll() {
  if (!session || !video) return;
  const result = await send({ type: "POLL" });
  if (result?.state) applyState(result.state);
}

async function sync() {
  if (!session || !video) return;
  await reportState();
  await poll();
}

function bindVideo(nextVideo) {
  if (video === nextVideo) return;
  video = nextVideo;
  for (const event of ["play", "pause", "seeked", "ratechange"]) {
    video.addEventListener(event, reportState);
  }
  reportState();
  poll();
}

function findVideo() {
  const videos = [...document.querySelectorAll("video")];
  const candidate = videos.find((item) => item.offsetWidth > 300) || videos[0] || null;
  if (candidate) bindVideo(candidate);
}

function start() {
  findVideo();
  videoObserver ??= new MutationObserver(findVideo);
  videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  clearInterval(pollTimer);
  pollTimer = setInterval(sync, SYNC_INTERVAL_MS);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SESSION_CHANGED") {
    session = message.session;
    lastRevision = 0;
    if (session) reportState();
  }
  if (message.type === "GET_LOCAL_STATE") sendResponse({ state: localState(), supported: Boolean(video) });
  if (message.type === "REPORT_STATE") reportState();
});

send({ type: "GET_SESSION" }).then((result) => {
  session = result?.session || null;
  start();
});
