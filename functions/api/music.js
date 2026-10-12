
import { createClient } from "@supabase/supabase-js";

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VALID_CODE = /^[A-HJ-NP-Z2-9]{16}$/;

const AUDIUS_HOSTS = [
  "https://api.audius.co/v1",
  "https://discoveryprovider.audius.co/v1"
];

function response(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: HEADERS
  });
}

function clean(value, max = 200) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function database(env) {
  const url = env.SUPABASE_URL;
  const key =
    env.SUPABASE_SECRET_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase environment variables.");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return Array.from(
    bytes,
    byte => ALPHABET[byte % ALPHABET.length]
  ).join("");
}

function validateTrack(track) {
  if (!track || typeof track !== "object") return null;

  const trackId = clean(String(track.trackId || ""), 100);
  const trackName = clean(track.trackName);
  const artistName = clean(track.artistName);
  const previewUrl = clean(track.previewUrl, 1500);
  const artworkUrl = clean(track.artworkUrl, 1500);

  if (!trackId || !trackName || !artistName) {
    return null;
  }

  // Only accept Audius stream URLs.
  try {
    const url = new URL(previewUrl);

    if (
      url.protocol !== "https:" ||
      ![
        "api.audius.co",
        "discoveryprovider.audius.co"
      ].includes(url.hostname) ||
      !url.pathname.endsWith("/stream")
    ) {
      return null;
    }
  } catch {
    return null;
  }

  if (artworkUrl) {
    try {
      const artwork = new URL(artworkUrl);

      if (artwork.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }

  return {
    trackId,
    trackName,
    artistName,
    albumName: clean(track.albumName),
    previewUrl,
    artworkUrl,
    durationMs: Math.max(0, Number(track.durationMs) || 0)
  };
}

async function findRoom(db, code) {
  if (!VALID_CODE.test(code)) return null;

  const { data, error } = await db
    .from("music_rooms")
    .select("*")
    .eq("room_code", code)
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

function getArtwork(track) {
  const artwork = track.artwork || {};

  if (typeof artwork === "string") {
    return artwork;
  }

  return (
    artwork["480x480"] ||
    artwork["150x150"] ||
    artwork["1000x1000"] ||
    ""
  );
}

async function searchSongs(term) {
  const query = clean(term, 100);

  if (!query) return [];

  let lastError;

  for (const host of AUDIUS_HOSTS) {
    try {
      const url = new URL(`${host}/tracks/search`);

      url.searchParams.set("query", query);
      url.searchParams.set("limit", "20");
      url.searchParams.set("app_name", "OurMusic");

      const result = await fetch(url.toString(), {
        headers: { Accept: "application/json" }
      });

      if (!result.ok) {
        lastError = new Error(
          `Audius returned HTTP ${result.status}.`
        );
        continue;
      }

      const payload = await result.json();

      if (!Array.isArray(payload.data)) {
        lastError = new Error("Invalid Audius search response.");
        continue;
      }

      return payload.data
        .filter(track => track && track.id && track.title)
        .map(track => {
          const streamUrl =
            `${host}/tracks/${encodeURIComponent(String(track.id))}/stream` +
            `?app_name=OurMusic`;

          return {
            trackId: String(track.id),
            trackName: track.title || "Unknown track",
            artistName: track.user?.name || "Unknown artist",
            albumName: track.album_title || "",
            previewUrl: streamUrl,
            artworkUrl: getArtwork(track),
            durationMs: Math.max(0, Number(track.duration) || 0) * 1000
          };
        });
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Audius search failed: ${lastError?.message || "Unknown error"}`
  );
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return response(405, {
      ok: false,
      error: "Use POST."
    });
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return response(400, {
      ok: false,
      error: "Invalid JSON."
    });
  }

  const action = clean(body.action, 30);

  try {
    // Audius search does not require Supabase.
    if (action === "search") {
      const tracks = await searchSongs(
        body.query || body.term || ""
      );

      return response(200, {
        ok: true,
        tracks
      });
    }

    // Room and queue operations still use Supabase.
    const db = database(env);

    if (action === "createRoom") {
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = makeRoomCode();

        const { error } = await db
          .from("music_rooms")
          .insert({
            room_code: code,
            current_track: null,
            is_playing: false,
            position_seconds: 0,
            updated_at: new Date().toISOString()
          });

        if (!error) {
          return response(200, {
            ok: true,
            roomCode: code
          });
        }

        if (error.code !== "23505") throw error;
      }

      throw new Error("Could not create a unique room.");
    }

    const code = clean(
      body.roomCode || body.room_code,
      16
    ).toUpperCase();

    if (!VALID_CODE.test(code)) {
      return response(400, {
        ok: false,
        error: "Enter a valid 16-character room code."
      });
    }

    const room = await findRoom(db, code);

    if (!room) {
      return response(404, {
        ok: false,
        error: "Room not found."
      });
    }

    if (action === "joinRoom") {
      return response(200, {
        ok: true,
        roomCode: code
      });
    }

    if (action === "getRoom") {
      const { data: queue, error } = await db
        .from("music_queue")
        .select("*")
        .eq("room_code", code)
        .order("position", { ascending: true });

      if (error) throw error;

      return response(200, {
        ok: true,
        room,
        queue: queue || []
      });
    }

    if (action === "addTrack") {
      const track = validateTrack(body.track);

      if (!track) {
        return response(400, {
          ok: false,
          error: "Invalid Audius track or stream URL."
        });
      }

      const { data: last, error: lastError } = await db
        .from("music_queue")
        .select("position")
        .eq("room_code", code)
        .order("position", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastError) throw lastError;

      const { data, error } = await db
        .from("music_queue")
        .insert({
          room_code: code,
          track,
          position: last ? Number(last.position) + 1 : 1,
          added_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;

      return response(200, {
        ok: true,
        item: data
      });
    }

    if (action === "setPlayback") {
      const updates = {
        updated_at: new Date().toISOString()
      };

      if ("currentTrack" in body) {
        if (body.currentTrack === null) {
          updates.current_track = null;
        } else {
          const track = validateTrack(body.currentTrack);

          if (!track) {
            return response(400, {
              ok: false,
              error: "Invalid Audius track."
            });
          }

          updates.current_track = track;
        }
      }

      if ("isPlaying" in body) {
        if (typeof body.isPlaying !== "boolean") {
          return response(400, {
            ok: false,
            error: "Invalid playing state."
          });
        }

        updates.is_playing = body.isPlaying;
      }

      if ("positionSeconds" in body) {
        const position = Number(body.positionSeconds);

        if (!Number.isFinite(position) || position < 0) {
          return response(400, {
            ok: false,
            error: "Invalid playback position."
          });
        }

        updates.position_seconds = position;
      }

      const { data, error } = await db
        .from("music_rooms")
        .update(updates)
        .eq("room_code", code)
        .select()
        .single();

      if (error) throw error;

      return response(200, {
        ok: true,
        room: data
      });
    }

    return response(400, {
      ok: false,
      error: "Unknown action."
    });
  } catch (error) {
    console.error("Our Music error:", {
      action,
      message: error?.message || "Unknown error"
    });

    return response(500, {
      ok: false,
      error: action === "search"
        ? "Audius search failed. Check the Cloudflare function logs."
        : "Server error. Check Cloudflare and Supabase settings."
    });
  }
}
