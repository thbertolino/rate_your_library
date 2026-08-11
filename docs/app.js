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

const SCOPES = "user-library-read";

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
let albumOpenedFrom = "artist"; // "artist" | "ratings" | "artists" - where back-btn on album view should go
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
const randomUnheardBtn = el("random-unheard-btn");
const randomHeardBtn = el("random-heard-btn");
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
const listenedToggle = el("listened-toggle");
const listenedCheckbox = el("listened-checkbox");
const tracksLoadingEl = el("tracks-loading");
const tracksErrorEl = el("tracks-error");
const tracksRetryBtn = el("tracks-retry-btn");
const trackListEl = el("track-list");
const refreshTracksBtn = el("refresh-tracks-btn");

const ratingsListEl = el("ratings-list");
const ratingsEmptyEl = el("ratings-empty");
const ratingsSearchInput = el("ratings-search-input");

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
    if (tab === "ratings") renderRatingsView(ratingsSearchInput.value);
  };
});

backToArtistsBtn.onclick = () => {
  renderArtistList(searchInput.value); // atualiza o destaque de "artista completo" ao voltar
  showView("artists");
};

backBtn.onclick = () => {
  if (albumOpenedFrom === "ratings") {
    showView("ratings");
  } else if (albumOpenedFrom === "artists") {
    renderArtistList(searchInput.value); // atualiza o destaque de "artista completo" ao voltar
    showView("artists");
  } else {
    showView("artist");
  }
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
// copyrights, genres...) e isso pesa demais pra guardar no localStorage com
// quase mil albuns. As faixas (tracks), por outro lado, a gente MANTEM: o
// Spotify ja devolve o album inteiro (com as faixas embutidas) dentro da
// resposta de /me/albums - que nunca deu 429 - entao aproveitamos isso pra
// nunca precisar chamar o endpoint de faixas separado (que esta com cota
// estourada) pra album nenhum que caiba numa unica pagina de faixas.
function leanAlbumItem({ album }) {
  return {
    album: {
      id: album.id,
      name: album.name,
      images: album.images,
      artists: album.artists.map((a) => ({ id: a.id, name: a.name })),
      external_urls: { spotify: album.external_urls?.spotify },
      tracks: album.tracks
        ? {
            items: (album.tracks.items || []).map(leanTrack),
            total: album.tracks.total ?? album.tracks.items?.length ?? 0,
          }
        : null,
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
  return r.listened ? '<span class="badge-listened">✅</span>' : "";
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

function isArtistFullyListened(artist) {
  return artist.albums.length > 0 && artist.albums.every((album) => ratingsCache[album.id]?.listened);
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
    const fullyListened = isArtistFullyListened(artist);

    const li = document.createElement("li");
    li.className = `album-row${fullyListened ? " artist-complete" : ""}`;
    li.dataset.artistId = artist.id;
    li.innerHTML = `
      <img src="${artist.imageUrl}" alt="" />
      <div class="album-row-info">
        <div class="album-row-title">${escapeHtml(artist.name)}</div>
        <div class="album-row-artist">${artist.albums.length} álbum${artist.albums.length === 1 ? "" : "s"}</div>
      </div>
      ${fullyListened ? '<span class="artist-complete-badge" title="Todos os álbuns já ouvidos">🏆</span>' : ""}
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

    const img = document.createElement("img");
    img.src = album.images?.[1]?.url || album.images?.[0]?.url || album.images?.[2]?.url || "";
    img.alt = "";

    const info = document.createElement("div");
    info.className = "album-row-info";
    const title = document.createElement("div");
    title.className = "album-row-title";
    title.textContent = album.name;
    info.appendChild(title);

    const badges = document.createElement("div");
    badges.className = "album-row-badges";

    const listened = !!ratingsCache[album.id]?.listened;
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = `listened-quick-toggle ${listened ? "on" : ""}`;
    toggleBtn.title = listened ? "Marcar como não ouvido" : "Marcar como já ouvido";
    toggleBtn.textContent = listened ? "✅" : "⬜";
    toggleBtn.onclick = async (e) => {
      e.stopPropagation(); // nao abre o album, so alterna o "ja ouvi"
      toggleBtn.disabled = true;
      await saveRating(album, { listened: !listened });
      refreshBadgesEverywhere();
    };
    badges.appendChild(toggleBtn);

    li.append(img, info, badges);
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

ratingsSearchInput.oninput = () => {
  renderRatingsView(ratingsSearchInput.value);
};

DESKTOP_QUERY.addEventListener("change", () => {
  artistPage = 1;
  if (!views.artists.classList.contains("hidden")) renderArtistList(searchInput.value);
});

function pickRandomAlbum(matches) {
  const candidates = allAlbums.filter(({ album }) => matches(album));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)].album;
}

randomUnheardBtn.onclick = () => {
  const album = pickRandomAlbum((album) => !ratingsCache[album.id]?.listened);
  if (!album) {
    alert("Todos os seus álbuns já estão marcados como ouvidos!");
    return;
  }
  albumOpenedFrom = "artists";
  openAlbum(album);
};

randomHeardBtn.onclick = () => {
  const album = pickRandomAlbum((album) => !!ratingsCache[album.id]?.listened);
  if (!album) {
    alert("Você ainda não marcou nenhum álbum como ouvido.");
    return;
  }
  albumOpenedFrom = "artists";
  openAlbum(album);
};

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

async function saveRating(album, { listened }) {
  const existing = ratingsCache[album.id] || {};
  const payload = {
    userId: currentUserId,
    albumId: album.id,
    name: album.name,
    artist: album.artists.map((a) => a.name).join(", "),
    imageUrl: album.images?.[0]?.url || "",
    spotifyUrl: album.external_urls?.spotify || "",
    listened: listened !== undefined ? listened : existing.listened ?? false,
    updatedAt: new Date().toISOString(),
  };

  await setDoc(doc(db, "ratings", ratingDocId(currentUserId, album.id)), payload);
  ratingsCache[album.id] = payload;
}

function renderRatingsView(filterText = "") {
  ratingsListEl.innerHTML = "";
  const term = filterText.trim().toLowerCase();

  const rated = Object.entries(ratingsCache)
    .filter(([, r]) => r.listened)
    .filter(
      ([, r]) => !term || (r.name || "").toLowerCase().includes(term) || (r.artist || "").toLowerCase().includes(term)
    )
    .sort((a, b) => new Date(b[1].updatedAt || 0) - new Date(a[1].updatedAt || 0));

  ratingsEmptyEl.classList.toggle("hidden", rated.length > 0);
  ratingsEmptyEl.innerHTML = term
    ? "Nenhum álbum avaliado encontrado com esse termo."
    : "Você ainda não avaliou nenhum álbum.<br />Toque em um álbum na sua biblioteca para começar.";

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

  const r = ratingsCache[album.id] || { listened: false };
  listenedCheckbox.checked = !!r.listened;
  listenedToggle.classList.toggle("on", !!r.listened);

  await loadAlbumTracks(album);
}

let currentTracks = [];

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

// Uma vez que as faixas de um album carregam com sucesso, ficam salvas no
// navegador - reabrir o mesmo album (ou ver de novo mais tarde) nao pede
// nada ao Spotify, so quando o usuario pedir "Atualizar faixas".
async function loadAlbumTracks(album, { forceRefresh = false } = {}) {
  trackListEl.innerHTML = "";
  tracksErrorEl.classList.add("hidden");
  tracksRetryBtn.classList.add("hidden");
  refreshTracksBtn.classList.add("hidden");

  // O album ja veio com as faixas embutidas (parte da resposta de /me/albums,
  // que nunca deu 429) - se vieram todas, nem precisa chamar o endpoint de
  // faixas separado (que esta com cota estourada).
  const embeddedTracks = album.tracks;
  if (!forceRefresh && embeddedTracks && embeddedTracks.items.length >= embeddedTracks.total) {
    currentTracks = embeddedTracks.items;
    renderTrackList(currentTracks);
    refreshTracksBtn.classList.remove("hidden");
    saveTrackListToCache(album.id, currentTracks);
    return;
  }

  const cached = !forceRefresh ? loadTracksCache()[album.id] : null;
  if (cached) {
    currentTracks = cached.tracks;
    renderTrackList(currentTracks);
    refreshTracksBtn.classList.remove("hidden");
    return;
  }

  tracksLoadingEl.classList.remove("hidden");

  try {
    const tracksRes = await spotifyFetch(`https://api.spotify.com/v1/albums/${album.id}/tracks?limit=50`, {}, 3);

    if (!tracksRes.ok) {
      if (tracksRes.status === 429) {
        const retryAfter = Number(tracksRes.headers.get("Retry-After")) || null;
        throw Object.assign(new Error("RATE_LIMITED"), { retryAfter });
      }
      throw new Error(`HTTP_${tracksRes.status}`);
    }

    const tracksData = await tracksRes.json();
    currentTracks = (tracksData.items || []).map(leanTrack);

    renderTrackList(currentTracks);
    refreshTracksBtn.classList.toggle("hidden", currentTracks.length === 0);
    saveTrackListToCache(album.id, currentTracks);
  } catch (err) {
    console.error("Erro ao carregar faixas:", err);
    tracksErrorEl.textContent =
      err.message === "RATE_LIMITED"
        ? `⚠️ Muitas requisições ao Spotify agora${err.retryAfter ? ` (tente de novo em ${formatWaitTime(err.retryAfter)})` : ""}. Toque em "Tentar novamente".`
        : "Não foi possível carregar as faixas desse álbum.";
    tracksErrorEl.classList.remove("hidden");
    tracksRetryBtn.classList.remove("hidden");
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

function renderTrackList(tracks) {
  trackListEl.innerHTML = "";

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

    mainRow.append(numberSpan, nameSpan);
    li.append(mainRow);
    trackListEl.appendChild(li);
  });
}

function refreshBadgesEverywhere() {
  if (currentArtist) renderArtistAlbums(currentArtist);
  renderRatingsView(ratingsSearchInput.value);
  if (!views.artists.classList.contains("hidden")) renderArtistList(searchInput.value);
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
