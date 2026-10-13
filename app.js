(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const player = $("player");
  const ROOM_KEY = "ourMusicRoomCodeV2";
  let roomCode = "";
  let queue = [];
  let searchTracks = [];
  let currentTrack = null;
  let lastRemoteTrackId = null;
  let lastPositionSent = 0;
  let applyingRemoteState = false;
  let pollBusy = false;
  let searchRequest = 0;
  let toastTimer = null;
  let pendingRemotePosition = 0;

  function showToast(message) {
    $("toast").textContent = message;
    $("toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2800);
  }
  function setRoomStatus(message, type = "") {
    $("roomStatus").textContent = message;
    $("roomStatus").className = "status" + (type ? " " + type : "");
  }
  function setConnection(connected) {
    $("connectionDot").classList.toggle("live", connected);
    $("connectionText").textContent = connected ? "Connected" : "Reconnecting";
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    })[c]);
  }
  function safeImageUrl(value) {
    try { const u = new URL(value); return u.protocol === "https:" ? u.href : ""; }
    catch { return ""; }
  }
  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return "0:00";
    const s = Math.floor(value);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  async function api(action, extra = {}) {
    const response = await fetch("/api/music", {
      method:"POST", headers:{"Content-Type":"application/json"}, cache:"no-store",
      body:JSON.stringify({action, ...(roomCode ? {roomCode} : {}), ...extra})
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error("The server response was not valid JSON."); }
    if (!response.ok || !data.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  function getTrack(item) { return item?.track || item; }
  function makeSongHtml(track, text, action, index) {
    const cover = safeImageUrl(track?.artworkUrl);
    const image = cover
      ? `<img class="cover" src="${escapeHtml(cover)}" alt="" loading="lazy">`
      : `<div class="cover artplaceholder" style="width:52px;height:52px;aspect-ratio:1;font-size:1.4rem" aria-hidden="true">♫</div>`;
    return `<div class="song">${image}<div class="songinfo"><div class="songtitle">${escapeHtml(track?.trackName || "Unknown track")}</div><div class="songartist">${escapeHtml(track?.artistName || "Unknown artist")}</div></div><button type="button" class="${action === "add" ? "secondary" : "primary"}" data-action="${action}" data-index="${index}">${text}</button></div>`;
  }
  function renderSearchResults(tracks) {
    searchTracks = Array.isArray(tracks) ? tracks : [];
    const target = $("searchResults");
    if (!searchTracks.length) {
      target.innerHTML = '<p class="empty">No tracks found. Try another title or artist.</p>';
      return;
    }
    target.innerHTML = searchTracks.map((track, index) => makeSongHtml(track, "＋ Add", "add", index)).join("");
  }
  function renderQueue() {
    $("queueCount").textContent = `${queue.length} ${queue.length === 1 ? "song" : "songs"}`;
    if (!roomCode) {
      $("queueList").innerHTML = '<p class="empty">Create or join a room to see the queue.</p>';
      return;
    }
    if (!queue.length) {
      $("queueList").innerHTML = '<p class="empty">Your queue is ready for its first song. ♡</p>';
      return;
    }
    $("queueList").innerHTML = queue.map((item, index) => makeSongHtml(getTrack(item), "▶ Play", "play", index)).join("");
  }
  function updatePlayerArtwork(track) {
    const cover = safeImageUrl(track?.artworkUrl);
    if (cover) {
      $("playerArt").src = cover; $("playerArt").hidden = false;
      $("artPlaceholder").hidden = true; $("miniArt").src = cover;
    } else {
      $("playerArt").removeAttribute("src"); $("playerArt").hidden = true;
      $("artPlaceholder").hidden = false; $("miniArt").removeAttribute("src");
    }
  }
  function updatePlayButtons() {
    const playing = !player.paused && !player.ended;
    $("playBtn").textContent = playing ? "Ⅱ" : "▶";
    $("playBtn").setAttribute("aria-label", playing ? "Pause" : "Play");
    $("miniPlayBtn").textContent = playing ? "Ⅱ" : "▶";
    $("miniPlayBtn").setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  function renderNowPlaying(track) {
    if (!track) {
      $("playerTitle").textContent = "A song for the two of you";
      $("playerArtist").textContent = "Choose a track from your queue";
      $("miniTitle").textContent = "Our Music"; $("miniArtist").textContent = "Ready when you are";
      $("miniPlayer").hidden = true; updatePlayerArtwork(null); updatePlayButtons(); return;
    }
    $("playerTitle").textContent = track.trackName || "Unknown track";
    $("playerArtist").textContent = track.artistName || "Unknown artist";
    $("miniTitle").textContent = track.trackName || "Unknown track";
    $("miniArtist").textContent = track.artistName || "Unknown artist";
    $("miniPlayer").hidden = false; updatePlayerArtwork(track); updatePlayButtons();
  }
  function updateProgress() {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    const current = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    $("currentTime").textContent = formatTime(current);
    $("duration").textContent = formatTime(duration);
    $("seekBar").disabled = !duration;
    $("seekBar").value = duration ? String(Math.round(current / duration * 1000)) : "0";
  }
  async function createRoom() {
    $("createBtn").disabled = true; setRoomStatus("Creating your room…");
    try {
      const data = await api("createRoom");
      if (!data.roomCode) throw new Error("The server did not return a room code.");
      roomCode = String(data.roomCode); localStorage.setItem(ROOM_KEY, roomCode);
      $("roomInput").value = roomCode; $("roomDisplay").textContent = roomCode;
      $("copyBtn").disabled = false; setRoomStatus("Room ready! Share this code with your person. ♡", "success");
      await refreshRoom();
    } catch (error) { setRoomStatus(error.message, "error"); showToast(error.message); }
    finally { $("createBtn").disabled = false; }
  }
  async function joinRoom() {
    const code = $("roomInput").value.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{16}$/.test(code)) {
      setRoomStatus("Please enter the complete 16-character room code.", "error"); return;
    }
    $("joinBtn").disabled = true; setRoomStatus("Joining your shared room…");
    const previous = roomCode; roomCode = code;
    try {
      await api("joinRoom");
      localStorage.setItem(ROOM_KEY, roomCode);
      $("roomInput").value = roomCode; $("roomDisplay").textContent = roomCode;
      $("copyBtn").disabled = false; setRoomStatus("Connected to your shared room. ♡", "success");
      await refreshRoom();
    } catch (error) {
      roomCode = previous;
      setRoomStatus(error.message, "error"); showToast(error.message);
    } finally { $("joinBtn").disabled = false; }
  }
  async function copyRoomCode() {
    if (!roomCode) return;
    try { await navigator.clipboard.writeText(roomCode); showToast("Room code copied. Send it to your person! ♡"); }
    catch { $("roomInput").focus(); $("roomInput").select(); showToast("Select the room code and copy it."); }
  }
  async function searchSongs(event) {
    event?.preventDefault();
    const query = $("searchInput").value.trim();
    if (!query) { showToast("Type a song or artist name first."); $("searchInput").focus(); return; }
    const requestId = ++searchRequest;
    $("searchBtn").disabled = true;
    $("searchResults").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    try {
      const data = await api("search", {query});
      if (requestId !== searchRequest) return;
      renderSearchResults(data.tracks || []);
    } catch (error) {
      if (requestId !== searchRequest) return;
      $("searchResults").innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
      showToast(error.message);
    } finally { if (requestId === searchRequest) $("searchBtn").disabled = false; }
  }
  async function addTrack(track, button) {
    if (!roomCode) {
      setRoomStatus("Create or join a room before adding songs.", "error");
      showToast("Join your shared room first."); return;
    }
    if (!track) { showToast("Please search for that song again."); return; }
    if (button) { button.disabled = true; button.textContent = "Adding…"; }
    try {
      await api("addTrack", {track});
      showToast("Added to your shared queue ♡");
      setRoomStatus("Song added to the shared queue.", "success");
      await refreshRoom();
    } catch (error) {
      setRoomStatus(error.message, "error"); showToast(error.message || "Could not add this song.");
    } finally {
      if (button && button.isConnected) { button.disabled = false; button.textContent = "＋ Add"; }
    }
  }
  async function setSharedPlayback(values) {
    if (!roomCode) return;
    try { await api("setPlayback", values); }
    catch (error) { setRoomStatus(error.message, "error"); }
  }
  async function playTrack(track) {
    if (!roomCode) { showToast("Create or join a room first."); return; }
    if (!track?.previewUrl) { showToast("This track has no playable stream. Try another song."); return; }
    currentTrack = track; lastRemoteTrackId = String(track.trackId);
    pendingRemotePosition = 0; applyingRemoteState = true;
    player.src = track.previewUrl; player.load(); renderNowPlaying(track);
    $("playStatus").textContent = "Starting your song…";
    try {
      await setSharedPlayback({currentTrack:track, isPlaying:true, positionSeconds:0});
      try { await player.play(); $("playStatus").textContent = "Enjoy your song together. ♡"; }
      catch { $("playStatus").textContent = "Tap Play to start listening on this phone."; showToast("Tap Play to start the music."); }
    } finally { applyingRemoteState = false; updatePlayButtons(); }
  }
  async function togglePlayback() {
    if (!currentTrack && !player.src) {
      const first = queue[0] && getTrack(queue[0]);
      if (first) return playTrack(first);
      showToast("Add a song to your queue first."); return;
    }
    if (player.paused) {
      try { await player.play(); $("playStatus").textContent = "Enjoy your song together. ♡"; }
      catch { $("playStatus").textContent = "Playback could not start. Try another track."; showToast("Couldn't start this track."); }
    } else { player.pause(); }
    updatePlayButtons();
  }
  async function refreshRoom() {
    if (!roomCode || pollBusy || document.hidden) return;
    pollBusy = true;
    try {
      const data = await api("getRoom");
      setConnection(true);
      queue = Array.isArray(data.queue) ? data.queue : [];
      renderQueue();
      const room = data.room || {};
      const track = room.current_track;
      if (!track) {
        if (currentTrack) {
          currentTrack = null; lastRemoteTrackId = null; applyingRemoteState = true;
          player.pause(); player.removeAttribute("src"); player.load(); applyingRemoteState = false;
          renderNowPlaying(null); updateProgress();
        }
        return;
      }
      const remoteId = String(track.trackId);
      const isNewTrack = remoteId !== String(lastRemoteTrackId);
      if (isNewTrack) {
        currentTrack = track; lastRemoteTrackId = remoteId;
        pendingRemotePosition = Math.max(0, Number(room.position_seconds) || 0);
        applyingRemoteState = true; player.src = track.previewUrl || ""; player.load();
        renderNowPlaying(track); applyingRemoteState = false;
      } else { currentTrack = track; }
      const remotePlaying = !!room.is_playing;
      const remotePosition = Math.max(0, Number(room.position_seconds) || 0);
      if (!isNewTrack && Number.isFinite(player.duration) && Math.abs(player.currentTime - remotePosition) > 4) {
        applyingRemoteState = true; try { player.currentTime = remotePosition; } catch {}
        applyingRemoteState = false;
      }
      if (remotePlaying && player.paused) {
        try { await player.play(); $("playStatus").textContent = "Listening together. ♡"; }
        catch { $("playStatus").textContent = "Your person started the song. Tap Play to listen here."; }
      } else if (!remotePlaying && !player.paused) {
        applyingRemoteState = true; player.pause(); applyingRemoteState = false;
      }
      updatePlayButtons();
    } catch (error) {
      setConnection(false); console.warn("Room refresh failed:", error.message);
    } finally { pollBusy = false; }
  }

  $("createBtn").addEventListener("click", createRoom);
  $("joinBtn").addEventListener("click", joinRoom);
  $("copyBtn").addEventListener("click", copyRoomCode);
  $("searchForm").addEventListener("submit", searchSongs);
  $("searchResults").addEventListener("click", event => {
    const button = event.target.closest("button[data-action='add']");
    if (!button) return;
    const track = searchTracks[Number(button.dataset.index)];
    addTrack(track, button);
  });
  $("queueList").addEventListener("click", event => {
    const button = event.target.closest("button[data-action='play']");
    if (!button) return;
    const item = queue[Number(button.dataset.index)];
    if (item) playTrack(getTrack(item));
  });
  $("playBtn").addEventListener("click", togglePlayback);
  $("miniPlayBtn").addEventListener("click", togglePlayback);
  $("restartBtn").addEventListener("click", () => {
    if (!player.src) return;
    try { player.currentTime = 0; if (player.paused) togglePlayback(); } catch {}
  });
  $("volumeBtn").addEventListener("click", () => {
    player.muted = !player.muted;
    $("volumeBtn").textContent = player.muted ? "×" : "♫";
    $("volumeBtn").setAttribute("aria-label", player.muted ? "Unmute" : "Mute");
  });
  $("seekBar").addEventListener("input", () => {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    if (duration) try { player.currentTime = Number($("seekBar").value) / 1000 * duration; } catch {}
  });
  $("seekBar").addEventListener("change", () => {
    if (roomCode) setSharedPlayback({positionSeconds:player.currentTime || 0});
  });
  player.addEventListener("loadedmetadata", () => {
    if (pendingRemotePosition > 0 && Number.isFinite(player.duration)) {
      try { player.currentTime = Math.min(pendingRemotePosition, player.duration); } catch {}
    }
    pendingRemotePosition = 0; updateProgress();
  });
  player.addEventListener("timeupdate", () => {
    updateProgress();
    if (applyingRemoteState || !roomCode || !currentTrack || Date.now() - lastPositionSent < 6000) return;
    lastPositionSent = Date.now();
    setSharedPlayback({positionSeconds:player.currentTime || 0});
  });
  player.addEventListener("play", () => {
    updatePlayButtons();
    if (!applyingRemoteState && roomCode) setSharedPlayback({isPlaying:true,positionSeconds:player.currentTime || 0});
  });
  player.addEventListener("pause", () => {
    updatePlayButtons();
    if (!applyingRemoteState && roomCode) setSharedPlayback({isPlaying:false,positionSeconds:player.currentTime || 0});
  });
  player.addEventListener("ended", () => {
    updatePlayButtons(); $("playStatus").textContent = "This track ended. Choose another song. ♡";
    setSharedPlayback({isPlaying:false,positionSeconds:0});
  });
  player.addEventListener("error", () => {
    $("playStatus").textContent = "This stream could not play. Try another track or check the connection.";
    updatePlayButtons();
  });
  $("expandBtn").addEventListener("click", () => $("playerPanel").scrollIntoView({behavior:"smooth",block:"center"}));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshRoom(); });
  window.addEventListener("online", () => { setConnection(true); refreshRoom(); });
  window.addEventListener("offline", () => setConnection(false));

  renderQueue(); updateProgress();
  const savedRoom = localStorage.getItem(ROOM_KEY);
  if (savedRoom && /^[A-HJ-NP-Z2-9]{16}$/.test(savedRoom)) {
    roomCode = savedRoom; $("roomInput").value = savedRoom; $("roomDisplay").textContent = savedRoom;
    $("copyBtn").disabled = false;
    setRoomStatus("Reconnecting to your last room…");
    refreshRoom().then(() => setRoomStatus("Connected to your saved room. ♡", "success"));
  }
  setInterval(refreshRoom, 2000);
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/sw.js").catch(error => console.warn("Service worker registration failed:", error));
  }
})();
