/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAy8NFNyZgKXtLK7n9RSDzUiWj9IsmqjGs",
  authDomain: "rate-your-library.firebaseapp.com",
  projectId: "rate-your-library",
  storageBucket: "rate-your-library.firebasestorage.app",
  messagingSenderId: "854798312295",
  appId: "1:854798312295:web:67e5a2277375885ee445c2",
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const SCOPES = "user-library-read user-library-modify";

// Nao e segredo (fluxo Authorization Code + PKCE, client publico).
const CLIENT_ID = "d7ae9370ca554540a1e671eda02ff844";
// Precisa bater exatamente com uma Redirect URI cadastrada no app do Spotify
// (calculado em runtime pra funcionar tanto local quanto no GitHub Pages).
const REDIRECT_URI = window.location.origin + window.location.pathname;

let allAlbums = []; // { album, addedAt } sorted alphabetically by artist
let artists = []; // [{ id, name, imageUrl, albums: [album,...] }] sorted alphabetically
let ratingsCache = {}; // albumId -> { rating, listened, ... }
let currentUserId = null;
let currentAlbum = null; // album object currently open in detail view
let currentArtist = null; // artist object currently open
let albumOpenedFrom = "artist"; // "artist" | "ratings" - where back-btn on album view should go
let artistPage = 1;

const DESKTOP_QUERY = window.matchMedia("(min-width: 860px)");
function getPageSize() {
  return DESKTOP_QUERY.matches ? 20 : 10;
}

/* --------------------------------------------------
   ELEMENTS
-------------------------------------------------- */
const el = (id) => document.getElementById(id);

const views = {
  login: el("view-login"),
  artists: el("view-artists"),
  artist: el("view-artist"),
  album: el("view-album"),
  ratings: el("view-ratings"),
};

const tabbar = el("tabbar");
const loginBtn = el("login-btn");
const logoutBtn = el("logout-btn");
const searchInput = el("search-input");
const artistListEl = el("artist-list");
const artistPaginationEl = el("artist-pagination");
const librarySyncNoteEl = el("library-sync-note");
const refreshLibraryBtn = el("refresh-library-btn");
const libraryLoadingEl = el("library-loading");
const libraryEmptyEl = el("library-empty");

const backToArtistsBtn = el("back-to-artists-btn");
const artistPageTitleEl = el("artist-page-title");
const artistAlbumListEl = el("artist-album-list");

const backBtn = el("back-btn");
const albumDetailImg = el("album-detail-img");
const albumDetailTitle = el("album-detail-title");
const albumDetailArtist = el("album-detail-artist");
const albumDetailLink = el("album-detail-link");
const albumRatingSummaryEl = el("album-rating-summary");
const listenedToggle = el("listened-toggle");
const listenedCheckbox = el("listened-checkbox");
const tracksLoadingEl = el("tracks-loading");
const tracksErrorEl = el("tracks-error");
const tracksRetryBtn = el("tracks-retry-btn");
const checkLikedBtn = el("check-liked-btn");
const trackListEl = el("track-list");
const refreshTracksBtn = el("refresh-tracks-btn");

const ratingsListEl = el("ratings-list");
const ratingsEmptyEl = el("ratings-empty");

/* --------------------------------------------------
   VIEW SWITCHING
-------------------------------------------------- */
function showView(name) {
  Object.entries(views).forEach(([key, node]) => {
    node.classList.toggle("hidden", key !== name);
  });
  tabbar.classList.toggle("hidden", name === "login");
  if (name === "artists" || name === "artist" || name === "ratings") {
    const tab = name === "artist" ? "artists" : name;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.onclick = () => {
    const tab = btn.dataset.tab;
    showView(tab);
    if (tab === "ratings") renderRatingsView();
  };
});

backToArtistsBtn.onclick = () => showView("artists");

backBtn.onclick = () => {
  showView(albumOpenedFrom === "ratings" ? "ratings" : "artist");
};

logoutBtn.onclick = () => {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  window.location.reload();
};

/* --------------------------------------------------
   PKCE HELPERS
-------------------------------------------------- */
async function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(codeVerifier) {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode.apply(null, [...new Uint8Array(digest)]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

loginBtn.onclick = async () => {
  const codeVerifier = await generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  localStorage.setItem("code_verifier", codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  });

  window.location = "https://accounts.spotify.com/authorize?" + params.toString();
};

async function getToken(code) {
  const codeVerifier = localStorage.getItem("code_verifier");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return response.json();
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem("refresh_token");
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await response.json();
    if (data.access_token) {
      localStorage.setItem("access_token", data.access_token);
      if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
      return data.access_token;
    }
  } catch (err) {
    console.error("Erro ao renovar token:", err);
  }
  return null;
}

async function spotifyFetch(url, options = {}, retriesLeft = 3) {
  let token = localStorage.getItem("access_token");
  let res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("TOKEN_EXPIRED");
    res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
  }

  // A biblioteca costuma disparar varias chamadas em sequencia (paginacao de
  // albuns, fotos de artista, etc) e o Spotify rate-limita isso com 429.
  if (res.status === 429 && retriesLeft > 0) {
    const retryAfterSeconds = Number(res.headers.get("Retry-After")) || 1;
    await new Promise((resolve) => setTimeout(resolve, (retryAfterSeconds + 0.25) * 1000));
    return spotifyFetch(url, options, retriesLeft - 1);
  }

  return res;
}

/* --------------------------------------------------
   LIBRARY
-------------------------------------------------- */
function sortAlbumItems(items) {
  return [...items].sort((a, b) => {
    const artistA = (a.album.artists[0]?.name || "").toLocaleLowerCase();
    const artistB = (b.album.artists[0]?.name || "").toLocaleLowerCase();
    return artistA.localeCompare(artistB);
  });
}

// So guarda os campos que o app realmente usa - o objeto "album" completo
// que o Spotify devolve traz bastante coisa que nao usamos (available_markets,
// copyrights, genres, faixas...) e isso pesa demais pra guardar no localStorage
// com quase mil albuns.
function leanAlbumItem({ album }) {
  return {
    album: {
      id: album.id,
      name: album.name,
      images: album.images,
      artists: album.artists.map((a) => ({ id: a.id, name: a.name })),
      external_urls: { spotify: album.external_urls?.spotify },
    },
  };
}

// Busca todas as paginas de albuns salvos, com uma pausa entre cada pagina
// pra nao estourar a cota (baixa) desse app. Com bibliotecas grandes (varias
// centenas de albuns) isso significa varias dezenas de chamadas - por isso o
// resultado e cacheado (ver LIBRARY_CACHE_KEY) e so refeito quando pedido.
async function fetchAllSavedAlbums(onProgress) {
  const items = [];
  let url = "https://api.spotify.com/v1/me/albums?limit=50";
  let isFirstPage = true;

  while (url) {
    if (!isFirstPage) await new Promise((resolve) => setTimeout(resolve, 300));
    isFirstPage = false;

    const res = await spotifyFetch(url, {}, 5);
    if (!res.ok) throw new Error("FAILED_ALBUMS");
    const data = await res.json();
    items.push(...data.items.map(leanAlbumItem));
    if (onProgress) onProgress(items.length);
    url = data.next;
  }

  return sortAlbumItems(items);
}

const LIBRARY_CACHE_KEY = "ryl_library_cache_v1";

function loadLibraryCache() {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveLibraryCache(items) {
  try {
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify({ items, fetchedAt: new Date().toISOString() }));
  } catch (err) {
    console.warn("Não foi possível salvar cache da biblioteca:", err);
  }
}

function albumBadgeHtml(albumId) {
  const r = ratingsCache[albumId];
  if (!r) return "";
  const listened = r.listened ? '<span class="badge-listened">✅</span>' : "";
  const stars = r.rating
    ? `<span class="badge-stars">${"★".repeat(Math.round(r.rating))} ${r.rating.toFixed(1)}</span>`
    : "";
  return listened + stars;
}

function buildArtistGroups() {
  const byId = new Map();
  allAlbums.forEach(({ album }) => {
    const primaryArtist = album.artists[0];
    if (!primaryArtist) return;
    if (!byId.has(primaryArtist.id)) {
      byId.set(primaryArtist.id, {
        id: primaryArtist.id,
        name: primaryArtist.name,
        imageUrl: album.images?.[1]?.url || album.images?.[0]?.url || album.images?.[2]?.url || "",
        albums: [],
      });
    }
    byId.get(primaryArtist.id).albums.push(album);
  });

  artists = Array.from(byId.values()).sort((a, b) =>
    a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase())
  );
}

function renderPagination(container, page, totalPages, onChange) {
  container.innerHTML = "";
  if (totalPages <= 1) return;

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.textContent = "← Anterior";
  prevBtn.disabled = page <= 1;
  prevBtn.onclick = () => onChange(page - 1);

  const label = document.createElement("span");
  label.textContent = `Página ${page} de ${totalPages}`;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.textContent = "Próxima →";
  nextBtn.disabled = page >= totalPages;
  nextBtn.onclick = () => onChange(page + 1);

  container.append(prevBtn, label, nextBtn);
}

function renderArtistList(filterText = "") {
  const term = filterText.trim().toLowerCase();
  artistListEl.innerHTML = "";

  const filtered = artists.filter((a) => !term || a.name.toLowerCase().includes(term));
  libraryEmptyEl.classList.toggle("hidden", filtered.length > 0);

  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (artistPage > totalPages) artistPage = totalPages;
  if (artistPage < 1) artistPage = 1;

  const start = (artistPage - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  pageItems.forEach((artist) => {
    const li = document.createElement("li");
    li.className = "album-row";
    li.dataset.artistId = artist.id;
    li.innerHTML = `
      <img src="${artist.imageUrl}" alt="" />
      <div class="album-row-info">
        <div class="album-row-title">${escapeHtml(artist.name)}</div>
        <div class="album-row-artist">${artist.albums.length} álbum${artist.albums.length === 1 ? "" : "s"}</div>
      </div>
    `;
    li.onclick = () => openArtist(artist);
    artistListEl.appendChild(li);
  });

  renderPagination(artistPaginationEl, artistPage, totalPages, (newPage) => {
    artistPage = newPage;
    renderArtistList(searchInput.value);
    artistListEl.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderArtistAlbums(artist) {
  artistPageTitleEl.textContent = artist.name;
  artistAlbumListEl.innerHTML = "";

  artist.albums.forEach((album) => {
    const li = document.createElement("li");
    li.className = "album-row";
    li.innerHTML = `
      <img src="${album.images?.[1]?.url || album.images?.[0]?.url || album.images?.[2]?.url || ""}" alt="" />
      <div class="album-row-info">
        <div class="album-row-title">${escapeHtml(album.name)}</div>
      </div>
      <div class="album-row-badges">${albumBadgeHtml(album.id)}</div>
    `;
    li.onclick = () => {
      albumOpenedFrom = "artist";
      openAlbum(album);
    };
    artistAlbumListEl.appendChild(li);
  });
}

function openArtist(artist) {
  currentArtist = artist;
  renderArtistAlbums(artist);
  showView("artist");
}

function openArtistById(artistId, artistName) {
  const found = artists.find((a) => a.id === artistId);
  if (found) {
    openArtist(found);
  } else {
    // fallback, caso o artista nao esteja no mapa (nao deveria acontecer)
    artistPageTitleEl.textContent = artistName;
    artistAlbumListEl.innerHTML = "";
    showView("artist");
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatWaitTime(seconds) {
  if (seconds < 60) return `${seconds} segundo${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minuto${minutes === 1 ? "" : "s"}`;
}

searchInput.oninput = () => {
  artistPage = 1;
  renderArtistList(searchInput.value);
};

DESKTOP_QUERY.addEventListener("change", () => {
  artistPage = 1;
  if (!views.artists.classList.contains("hidden")) renderArtistList(searchInput.value);
});

/* --------------------------------------------------
   RATINGS (Firestore)
-------------------------------------------------- */
const ratingsCollection = collection(db, "ratings");

function ratingDocId(userId, albumId) {
  return `${userId}_${albumId}`;
}

async function loadRatings() {
  ratingsCache = {};
  const q = query(ratingsCollection, where("userId", "==", currentUserId));
  const snapshot = await getDocs(q);
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    ratingsCache[data.albumId] = data;
  });
}

function basePayloadFor(album, existing) {
  return {
    userId: currentUserId,
    albumId: album.id,
    name: album.name,
    artist: album.artists.map((a) => a.name).join(", "),
    imageUrl: album.images?.[0]?.url || "",
    spotifyUrl: album.external_urls?.spotify || "",
    rating: existing.rating ?? 0,
    trackRatings: existing.trackRatings ?? {},
    listened: existing.listened ?? false,
  };
}

async function saveRating(album, { listened }) {
  const existing = ratingsCache[album.id] || {};
  const payload = {
    ...basePayloadFor(album, existing),
    listened: listened !== undefined ? listened : existing.listened ?? false,
    updatedAt: new Date().toISOString(),
  };

  await setDoc(doc(db, "ratings", ratingDocId(currentUserId, album.id)), payload);
  ratingsCache[album.id] = payload;
}

// A nota do album nao e mais escolhida direto: ela e a media das notas que
// o usuario deu pras faixas individuais (so as que ja foram avaliadas).
function computeAlbumRating(trackRatings) {
  const values = Object.values(trackRatings).filter((v) => v > 0);
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

async function saveTrackRating(album, trackId, newRating) {
  const existing = ratingsCache[album.id] || {};
  const trackRatings = { ...(existing.trackRatings || {}) };

  if (newRating > 0) {
    trackRatings[trackId] = newRating;
  } else {
    delete trackRatings[trackId];
  }

  const payload = {
    ...basePayloadFor(album, existing),
    trackRatings,
    rating: computeAlbumRating(trackRatings),
    updatedAt: new Date().toISOString(),
  };

  await setDoc(doc(db, "ratings", ratingDocId(currentUserId, album.id)), payload);
  ratingsCache[album.id] = payload;
}

function renderRatingsView() {
  ratingsListEl.innerHTML = "";
  const rated = Object.entries(ratingsCache)
    .filter(([, r]) => r.rating > 0 || r.listened)
    .sort((a, b) => new Date(b[1].updatedAt || 0) - new Date(a[1].updatedAt || 0));

  ratingsEmptyEl.classList.toggle("hidden", rated.length > 0);

  rated.forEach(([albumId, r]) => {
    const li = document.createElement("li");
    li.className = "album-row";
    li.innerHTML = `
      <img src="${r.imageUrl || ""}" alt="" />
      <div class="album-row-info">
        <div class="album-row-title">${escapeHtml(r.name || "")}</div>
        <div class="album-row-artist">${escapeHtml(r.artist || "")}</div>
      </div>
      <div class="album-row-badges">${albumBadgeHtml(albumId)}</div>
    `;
    li.onclick = () => {
      const found = allAlbums.find(({ album }) => album.id === albumId);
      if (found) {
        albumOpenedFrom = "ratings";
        openAlbum(found.album);
      } else {
        alert("Esse álbum não está mais salvo na sua biblioteca do Spotify.");
      }
    };
    ratingsListEl.appendChild(li);
  });
}

/* --------------------------------------------------
   ALBUM DETAIL
-------------------------------------------------- */
async function openAlbum(album) {
  currentAlbum = album;
  showView("album");

  albumDetailImg.src = album.images?.[0]?.url || "";
  albumDetailTitle.textContent = album.name;
  albumDetailArtist.textContent = album.artists.map((a) => a.name).join(", ");
  albumDetailArtist.onclick = () => {
    const primaryArtist = album.artists[0];
    if (primaryArtist) openArtistById(primaryArtist.id, primaryArtist.name);
  };
  albumDetailLink.href = album.external_urls?.spotify || "#";

  const r = ratingsCache[album.id] || { rating: 0, listened: false };
  renderAlbumRatingSummary(album);
  listenedCheckbox.checked = !!r.listened;
  listenedToggle.classList.toggle("on", !!r.listened);

  await loadAlbumTracks(album);
}

function renderAlbumRatingSummary(album) {
  const r = ratingsCache[album.id] || {};
  const trackRatings = r.trackRatings || {};
  const ratedCount = Object.keys(trackRatings).length;
  const totalCount = currentTracks.length || null;

  if (!ratedCount) {
    albumRatingSummaryEl.textContent = "Avalie as faixas abaixo para calcular a nota do álbum.";
    return;
  }

  const stars = "★".repeat(Math.round(r.rating)) + "☆".repeat(5 - Math.round(r.rating));
  const countLabel = totalCount ? `${ratedCount} de ${totalCount} faixas avaliadas` : `${ratedCount} faixas avaliadas`;
  albumRatingSummaryEl.textContent = `${stars} ${r.rating.toFixed(1)} — ${countLabel}`;
}

let currentTracks = [];
let currentSavedFlags = [];

// So guarda id/nome/numero da faixa - o resto do objeto que o Spotify manda
// (artists, disc_number, external_urls, preview_url etc.) o app nao usa.
function leanTrack(track) {
  return { id: track.id, name: track.name, track_number: track.track_number };
}

const TRACKS_CACHE_KEY = "ryl_tracks_cache_v1";

function loadTracksCache() {
  try {
    return JSON.parse(localStorage.getItem(TRACKS_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveTrackListToCache(albumId, tracks) {
  const cache = loadTracksCache();
  cache[albumId] = { tracks, fetchedAt: new Date().toISOString() };
  try {
    localStorage.setItem(TRACKS_CACHE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.warn("Não foi possível salvar cache de faixas:", err);
  }
}

// O Spotify documenta que apps em Development Mode tem uma COTA (nao so um
// limite de velocidade) por "bucket" de endpoints, com reason "QUOTA_EXCEEDED"
// - diferente de um rate limit comum, o periodo de reset nao e divulgado e
// pode ser bem mais que minutos. Sem Retry-After pra guiar, assumimos 1 hora
// como um chute mais realista (5 minutos nao foi suficiente na pratica).
const UNKNOWN_COOLDOWN_SECONDS = 60 * 60;
const RATE_LIMIT_COOLDOWN_KEY = "ryl_rate_limit_cooldown_until";
const RATE_LIMIT_QUOTA_KEY = "ryl_rate_limit_is_quota";
let cooldownIntervalId = null;

function getCooldownRemainingSeconds() {
  const until = Number(localStorage.getItem(RATE_LIMIT_COOLDOWN_KEY) || 0);
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function setCooldown(seconds, { isQuotaExceeded = false } = {}) {
  localStorage.setItem(RATE_LIMIT_COOLDOWN_KEY, String(Date.now() + seconds * 1000));
  localStorage.setItem(RATE_LIMIT_QUOTA_KEY, isQuotaExceeded ? "1" : "0");
}

// Mostra (e mantem atualizada, contando pra baixo) a mensagem de espera, sem
// tentar de novo sozinho - so reabilita o botao quando o tempo acabar. Assim
// a gente para de gastar a cota que ja esta estourada em tentativas inuteis.
function showCooldownCountdown() {
  if (cooldownIntervalId) clearInterval(cooldownIntervalId);
  const isQuotaExceeded = localStorage.getItem(RATE_LIMIT_QUOTA_KEY) === "1";

  const tick = () => {
    const remaining = getCooldownRemainingSeconds();
    if (remaining <= 0) {
      clearInterval(cooldownIntervalId);
      cooldownIntervalId = null;
      tracksErrorEl.textContent = "Pode tentar de novo agora.";
      tracksRetryBtn.classList.remove("hidden");
      return;
    }
    tracksErrorEl.textContent = isQuotaExceeded
      ? `⚠️ Cota de faixas do Spotify esgotada (apps pessoais tem uma cota baixa e sem prazo divulgado de reset). Tentando de novo em ${formatWaitTime(remaining)} - pode precisar de mais tempo ainda.`
      : `⚠️ Muitas requisições ao Spotify agora. Tente novamente em ${formatWaitTime(remaining)}.`;
    tracksRetryBtn.classList.add("hidden");
  };

  tick();
  cooldownIntervalId = setInterval(tick, 1000);
  tracksErrorEl.classList.remove("hidden");
}

// Uma vez que as faixas de um album carregam com sucesso, ficam salvas no
// navegador - reabrir o mesmo album (ou ver de novo mais tarde) nao pede
// nada ao Spotify, so quando o usuario pedir "Atualizar faixas".
async function loadAlbumTracks(album, { forceRefresh = false } = {}) {
  trackListEl.innerHTML = "";
  tracksErrorEl.classList.add("hidden");
  tracksRetryBtn.classList.add("hidden");
  checkLikedBtn.classList.add("hidden");
  refreshTracksBtn.classList.add("hidden");
  if (cooldownIntervalId) {
    clearInterval(cooldownIntervalId);
    cooldownIntervalId = null;
  }

  const cached = !forceRefresh ? loadTracksCache()[album.id] : null;
  if (cached) {
    currentTracks = cached.tracks;
    currentSavedFlags = currentTracks.map(() => null);
    renderTrackList(currentTracks, currentSavedFlags);
    checkLikedBtn.classList.toggle("hidden", currentTracks.length === 0);
    refreshTracksBtn.classList.remove("hidden");
    renderAlbumRatingSummary(album);
    return;
  }

  // Ja sabemos que a cota esta estourada - nem tenta, so mostra a contagem.
  if (getCooldownRemainingSeconds() > 0) {
    showCooldownCountdown();
    return;
  }

  tracksLoadingEl.classList.remove("hidden");

  try {
    // So 1 tentativa: com uma cota provavelmente esgotada por um bom tempo,
    // repetir rapido so soma tentativas inuteis (ja vimos isso acontecer).
    const tracksRes = await spotifyFetch(`https://api.spotify.com/v1/albums/${album.id}/tracks?limit=50`, {}, 1);

    if (!tracksRes.ok) {
      if (tracksRes.status === 429) {
        const retryAfter = Number(tracksRes.headers.get("Retry-After")) || null;
        const body = await tracksRes.json().catch(() => null);
        const isQuotaExceeded = body?.error?.reason === "QUOTA_EXCEEDED";
        setCooldown(retryAfter || UNKNOWN_COOLDOWN_SECONDS, { isQuotaExceeded });
        throw new Error("RATE_LIMITED");
      }
      throw new Error(`HTTP_${tracksRes.status}`);
    }

    const tracksData = await tracksRes.json();
    currentTracks = (tracksData.items || []).map(leanTrack);
    currentSavedFlags = currentTracks.map(() => null); // null = ainda nao verificado

    renderTrackList(currentTracks, currentSavedFlags);
    checkLikedBtn.classList.toggle("hidden", currentTracks.length === 0);
    refreshTracksBtn.classList.toggle("hidden", currentTracks.length === 0);
    saveTrackListToCache(album.id, currentTracks);
    renderAlbumRatingSummary(album);
  } catch (err) {
    console.error("Erro ao carregar faixas:", err);
    if (err.message === "RATE_LIMITED") {
      showCooldownCountdown();
    } else {
      tracksErrorEl.textContent = "Não foi possível carregar as faixas desse álbum.";
      tracksErrorEl.classList.remove("hidden");
      tracksRetryBtn.classList.remove("hidden");
    }
  } finally {
    tracksLoadingEl.classList.add("hidden");
  }
}

tracksRetryBtn.onclick = () => {
  if (currentAlbum) loadAlbumTracks(currentAlbum, { forceRefresh: true });
};

refreshTracksBtn.onclick = () => {
  if (currentAlbum) loadAlbumTracks(currentAlbum, { forceRefresh: true });
};

// A checagem de "quais faixas ja curti" e uma segunda chamada por album -
// deixamos sob demanda (o usuario pede clicando) em vez de automatica, pra
// nao dobrar o numero de requisicoes so de abrir um album.
checkLikedBtn.onclick = async () => {
  const trackIds = currentTracks.map((t) => t.id).filter(Boolean);
  if (!trackIds.length) return;

  checkLikedBtn.disabled = true;
  checkLikedBtn.textContent = "Verificando...";

  try {
    const containsRes = await spotifyFetch(
      `https://api.spotify.com/v1/me/tracks/contains?ids=${trackIds.join(",")}`,
      {},
      1
    );
    if (containsRes.ok) {
      currentSavedFlags = await containsRes.json();
      renderTrackList(currentTracks, currentSavedFlags);
      checkLikedBtn.classList.add("hidden");
    } else if (containsRes.status === 429) {
      alert("Cota do Spotify esgotada pra essa verificação agora. Tente de novo mais tarde.");
    } else {
      alert("Não foi possível verificar as faixas curtidas agora.");
    }
  } catch (err) {
    console.error("Erro ao verificar faixas curtidas:", err);
    alert("Não foi possível verificar as faixas curtidas agora.");
  } finally {
    checkLikedBtn.disabled = false;
    checkLikedBtn.textContent = "🤍 Ver quais já curti";
  }
};

function renderTrackList(tracks, savedFlags) {
  trackListEl.innerHTML = "";
  const trackRatings = ratingsCache[currentAlbum?.id]?.trackRatings || {};

  tracks.forEach((track, i) => {
    const li = document.createElement("li");
    li.className = "track-row";

    const mainRow = document.createElement("div");
    mainRow.className = "track-row-main";

    const numberSpan = document.createElement("span");
    numberSpan.className = "track-number";
    numberSpan.textContent = track.track_number ?? i + 1;

    const nameSpan = document.createElement("span");
    nameSpan.className = "track-name";
    nameSpan.textContent = track.name;

    const isUnknown = savedFlags[i] === null || savedFlags[i] === undefined;

    const heartBtn = document.createElement("button");
    heartBtn.type = "button";
    heartBtn.className = `track-saved ${savedFlags[i] ? "on" : ""}`;
    heartBtn.style.background = "transparent";
    heartBtn.style.border = "none";
    heartBtn.style.cursor = isUnknown ? "default" : "pointer";
    heartBtn.disabled = isUnknown;
    heartBtn.title = isUnknown
      ? 'Toque em "Ver quais já curti" acima pra verificar'
      : savedFlags[i]
      ? "Salva na sua biblioteca (clique para remover)"
      : "Não salva (clique para adicionar)";
    heartBtn.textContent = isUnknown ? "🤍" : savedFlags[i] ? "💚" : "🤍";
    heartBtn.style.opacity = isUnknown ? "0.35" : "1";
    if (!isUnknown) heartBtn.onclick = () => toggleTrackSaved(track.id, heartBtn, savedFlags, i);

    mainRow.append(numberSpan, nameSpan, heartBtn);

    const starRow = document.createElement("div");
    starRow.className = "track-star-picker";
    const currentTrackRating = trackRatings[track.id] || 0;

    for (let value = 1; value <= 5; value++) {
      const starEl = document.createElement("span");
      starEl.className = `star${value <= currentTrackRating ? " filled" : ""}`;
      starEl.dataset.value = value;
      starEl.textContent = "★";
      starEl.onclick = () => handleTrackStarClick(track.id, value, starRow);
      starRow.appendChild(starEl);
    }

    li.append(mainRow, starRow);
    trackListEl.appendChild(li);
  });
}

function setStarDisplayFor(container, rating) {
  container.querySelectorAll(".star").forEach((starEl) => {
    starEl.classList.toggle("filled", Number(starEl.dataset.value) <= rating);
  });
}

async function handleTrackStarClick(trackId, value, starRow) {
  if (!currentAlbum) return;
  const current = ratingsCache[currentAlbum.id]?.trackRatings?.[trackId] || 0;
  const newRating = value === current ? 0 : value; // toque na mesma estrela zera a nota da faixa

  setStarDisplayFor(starRow, newRating);
  await saveTrackRating(currentAlbum, trackId, newRating);
  renderAlbumRatingSummary(currentAlbum);
  refreshBadgesEverywhere();
}

async function toggleTrackSaved(trackId, heartBtn, savedFlags, index) {
  if (!trackId || heartBtn.disabled) return;
  heartBtn.disabled = true;

  const wasSaved = savedFlags[index];
  try {
    const res = await spotifyFetch(`https://api.spotify.com/v1/me/tracks?ids=${trackId}`, {
      method: wasSaved ? "DELETE" : "PUT",
    });

    if (res.status === 403) {
      // Token foi emitido antes de pedirmos a permissão user-library-modify.
      const shouldRelogin = confirm(
        "Sua sessão atual não tem permissão para curtir/descurtir músicas.\n\n" +
        "Isso acontece se você fez login antes dessa função existir. " +
        "Deseja sair e entrar novamente para conceder a permissão?"
      );
      if (shouldRelogin) {
        localStorage.removeItem("access_token");
        localStorage.removeItem("refresh_token");
        window.location.reload();
      }
      return;
    }

    if (!res.ok) throw new Error("TOGGLE_FAILED");

    savedFlags[index] = !wasSaved;
    heartBtn.classList.toggle("on", savedFlags[index]);
    heartBtn.textContent = savedFlags[index] ? "💚" : "🤍";
    heartBtn.title = savedFlags[index]
      ? "Salva na sua biblioteca (clique para remover)"
      : "Não salva (clique para adicionar)";
  } catch (err) {
    console.error("Erro ao atualizar faixa salva:", err);
    alert("Não foi possível atualizar essa faixa na sua biblioteca.");
  } finally {
    heartBtn.disabled = false;
  }
}

function refreshBadgesEverywhere() {
  if (currentArtist) renderArtistAlbums(currentArtist);
  renderRatingsView();
}

listenedToggle.onclick = async (e) => {
  if (e.target !== listenedCheckbox) listenedCheckbox.checked = !listenedCheckbox.checked;
  const listened = listenedCheckbox.checked;
  listenedToggle.classList.toggle("on", listened);
  await saveRating(currentAlbum, { listened });
  refreshBadgesEverywhere();
};

/* --------------------------------------------------
   BOOTSTRAP
-------------------------------------------------- */
async function start() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  let token = localStorage.getItem("access_token");

  if (code && !token) {
    try {
      const tokenResp = await getToken(code);
      if (tokenResp.access_token) {
        localStorage.setItem("access_token", tokenResp.access_token);
        if (tokenResp.refresh_token) localStorage.setItem("refresh_token", tokenResp.refresh_token);
        token = tokenResp.access_token;
      }
    } catch (err) {
      console.error("Falha ao trocar code por token:", err);
    } finally {
      window.history.replaceState({}, document.title, REDIRECT_URI);
    }
  }

  if (!token) {
    showView("login");
    return;
  }

  try {
    const meRes = await spotifyFetch("https://api.spotify.com/v1/me");
    if (!meRes.ok) throw new Error("ME_FAILED");
    const me = await meRes.json();
    currentUserId = me.id;
  } catch (err) {
    console.error("Sessão expirada:", err);
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    showView("login");
    return;
  }

  showView("artists");

  try {
    await loadRatings();
    await loadLibrary({ forceRefresh: false });
  } catch (err) {
    console.error("Erro ao carregar biblioteca:", err);
    libraryEmptyEl.textContent = "Não foi possível carregar sua biblioteca. Tente novamente.";
    libraryEmptyEl.classList.remove("hidden");
  }
}

// Usa o que ja tiver em cache (instantaneo, sem chamada nenhuma ao Spotify).
// So busca de verdade na primeira vez, ou quando o usuario pede pra atualizar
// no botao - assim a cota baixa desse app so precisa aguentar isso raramente,
// nao toda vez que a biblioteca abre.
async function loadLibrary({ forceRefresh }) {
  const cached = !forceRefresh ? loadLibraryCache() : null;

  if (cached) {
    allAlbums = cached.items;
    buildArtistGroups();
    renderArtistList();
    updateLibrarySyncNote(cached.fetchedAt);
    return;
  }

  libraryLoadingEl.classList.remove("hidden");
  const loadingLabelEl = libraryLoadingEl.querySelector("span");
  const originalLoadingLabel = loadingLabelEl.textContent;

  try {
    allAlbums = await fetchAllSavedAlbums((countSoFar) => {
      loadingLabelEl.textContent = `Carregando sua biblioteca... (${countSoFar} álbuns)`;
    });

    buildArtistGroups();
    renderArtistList();
    saveLibraryCache(allAlbums);
    updateLibrarySyncNote(new Date().toISOString());
  } finally {
    loadingLabelEl.textContent = originalLoadingLabel;
    libraryLoadingEl.classList.add("hidden");
  }
}

function updateLibrarySyncNote(isoDate) {
  if (!librarySyncNoteEl) return;
  const date = new Date(isoDate);
  librarySyncNoteEl.textContent = `Biblioteca sincronizada em ${date.toLocaleDateString("pt-BR")} às ${date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`;
}

refreshLibraryBtn.onclick = async () => {
  refreshLibraryBtn.disabled = true;
  try {
    await loadLibrary({ forceRefresh: true });
  } catch (err) {
    console.error("Erro ao atualizar biblioteca:", err);
    alert("Não foi possível atualizar sua biblioteca agora. Tente novamente em instantes.");
  } finally {
    refreshLibraryBtn.disabled = false;
  }
};

start();
