import { getRoom, updateRoom } from "@/lib/watch-party";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  const state = getRoom(roomId);
  if (!state) {
    return Response.json(
      { error: "Room not found" },
      { status: 404, headers: corsHeaders },
    );
  }
  return Response.json({ roomId: roomId.toUpperCase(), state }, { headers: corsHeaders });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  try {
    const { roomId } = await params;
    const state = updateRoom(roomId, await request.json());
    if (!state) {
      return Response.json(
        { error: "Room not found" },
        { status: 404, headers: corsHeaders },
      );
    }
    return Response.json({ roomId: roomId.toUpperCase(), state }, { headers: corsHeaders });
  } catch {
    return Response.json(
      { error: "Invalid request body" },
      { status: 400, headers: corsHeaders },
    );
  }
}
