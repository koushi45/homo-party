import { randomBytes } from "node:crypto";

export type PlaybackState = {
  mediaKey: string;
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  updatedAt: number;
  revision: number;
};

type Room = PlaybackState & {
  expiresAt: number;
};

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

declare global {
  var watchPartyRooms: Map<string, Room> | undefined;
}

const rooms = globalThis.watchPartyRooms ?? new Map<string, Room>();
globalThis.watchPartyRooms = rooms;

function cleanExpiredRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.expiresAt <= now) rooms.delete(roomId);
  }
}

function normalizeState(input: Partial<PlaybackState>, revision: number): Room {
  return {
    mediaKey: String(input.mediaKey ?? "").slice(0, 500),
    currentTime: Math.max(0, Number(input.currentTime) || 0),
    paused: input.paused !== false,
    playbackRate: Math.min(4, Math.max(0.25, Number(input.playbackRate) || 1)),
    updatedAt: Date.now(),
    revision,
    expiresAt: Date.now() + ROOM_TTL_MS,
  };
}

export function createRoom(initialState: Partial<PlaybackState>) {
  cleanExpiredRooms();
  let roomId = "";
  do {
    roomId = randomBytes(4).toString("hex").toUpperCase();
  } while (rooms.has(roomId));

  const room = normalizeState(initialState, 1);
  rooms.set(roomId, room);
  return { roomId, state: publicState(room) };
}

export function getRoom(roomId: string) {
  cleanExpiredRooms();
  const room = rooms.get(roomId.toUpperCase());
  if (!room) return null;

  room.expiresAt = Date.now() + ROOM_TTL_MS;
  return publicState(room);
}

export function updateRoom(roomId: string, input: Partial<PlaybackState>) {
  cleanExpiredRooms();
  const key = roomId.toUpperCase();
  const current = rooms.get(key);
  if (!current) return null;

  const next = normalizeState(input, current.revision + 1);
  rooms.set(key, next);
  return publicState(next);
}

function publicState(room: Room): PlaybackState {
  return {
    mediaKey: room.mediaKey,
    currentTime: room.currentTime,
    paused: room.paused,
    playbackRate: room.playbackRate,
    updatedAt: room.updatedAt,
    revision: room.revision,
  };
}
