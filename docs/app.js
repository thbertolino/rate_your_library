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
const CLIENT_ID = "5672ca28ebf240b891806b339bfc4972";
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
const starPicker = el("star-picker");
const listenedToggle = el("listened-toggle");
const listenedCheckbox = el("listened-checkbox");
const tracksLoadingEl = el("tracks-loading");
const trackListEl = el("track-list");

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

// Busca todas as paginas de albuns salvos. Chama onProgress a cada pagina
// (so pra atualizar o texto de "carregando"), mas so devolve o resultado
// completo no final: renderizar a lista alfabetica aos poucos faz os itens
// já exibidos pularem de posição conforme mais dados chegam, o que fica ruim.
async function fetchAllSavedAlbums(onProgress) {
  const items = [];
  let url = "https://api.spotify.com/v1/me/albums?limit=50";

  while (url) {
    const res = await spotifyFetch(url);
    if (!res.ok) throw new Error("FAILED_ALBUMS");
    const data = await res.json();
    items.push(...data.items);
    if (onProgress) onProgress(items.length);
    url = data.next;
  }

  return sortAlbumItems(items);
}

function albumBadgeHtml(albumId) {
  const r = ratingsCache[albumId];
  if (!r) return "";
  const listened = r.listened ? '<span class="badge-listened">✅</span>' : "";
  const stars = r.rating ? `<span class="badge-stars">${"★".repeat(r.rating)}</span>` : "";
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
        imageUrl: album.images?.[2]?.url || album.images?.[0]?.url || "",
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
      <img src="${album.images?.[2]?.url || album.images?.[0]?.url || ""}" alt="" />
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

async function saveRating(album, { rating, listened }) {
  const existing = ratingsCache[album.id] || {};
  const payload = {
    userId: currentUserId,
    albumId: album.id,
    name: album.name,
    artist: album.artists.map((a) => a.name).join(", "),
    imageUrl: album.images?.[0]?.url || "",
    spotifyUrl: album.external_urls?.spotify || "",
    rating: rating !== undefined ? rating : existing.rating ?? 0,
    listened: listened !== undefined ? listened : existing.listened ?? false,
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
  setStarDisplay(r.rating);
  listenedCheckbox.checked = !!r.listened;
  listenedToggle.classList.toggle("on", !!r.listened);

  trackListEl.innerHTML = "";
  tracksLoadingEl.classList.remove("hidden");

  try {
    const tracksRes = await spotifyFetch(`https://api.spotify.com/v1/albums/${album.id}/tracks?limit=50`);
    const tracksData = await tracksRes.json();
    const tracks = tracksData.items || [];

    let savedFlags = tracks.map(() => false);
    const trackIds = tracks.map((t) => t.id).filter(Boolean);
    if (trackIds.length) {
      const containsRes = await spotifyFetch(
        `https://api.spotify.com/v1/me/tracks/contains?ids=${trackIds.join(",")}`
      );
      if (containsRes.ok) savedFlags = await containsRes.json();
    }

    renderTrackList(tracks, savedFlags);
  } catch (err) {
    console.error("Erro ao carregar faixas:", err);
  } finally {
    tracksLoadingEl.classList.add("hidden");
  }
}

function renderTrackList(tracks, savedFlags) {
  trackListEl.innerHTML = "";
  tracks.forEach((track, i) => {
    const li = document.createElement("li");
    li.className = "track-row";

    const numberSpan = document.createElement("span");
    numberSpan.className = "track-number";
    numberSpan.textContent = track.track_number ?? i + 1;

    const nameSpan = document.createElement("span");
    nameSpan.className = "track-name";
    nameSpan.textContent = track.name;

    const heartBtn = document.createElement("button");
    heartBtn.type = "button";
    heartBtn.className = `track-saved ${savedFlags[i] ? "on" : ""}`;
    heartBtn.style.background = "transparent";
    heartBtn.style.border = "none";
    heartBtn.style.cursor = "pointer";
    heartBtn.title = savedFlags[i] ? "Salva na sua biblioteca (clique para remover)" : "Não salva (clique para adicionar)";
    heartBtn.textContent = savedFlags[i] ? "💚" : "🤍";
    heartBtn.onclick = () => toggleTrackSaved(track.id, heartBtn, savedFlags, i);

    li.append(numberSpan, nameSpan, heartBtn);
    trackListEl.appendChild(li);
  });
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

function setStarDisplay(rating) {
  document.querySelectorAll("#star-picker .star").forEach((starEl) => {
    starEl.classList.toggle("filled", Number(starEl.dataset.value) <= rating);
  });
}

function refreshBadgesEverywhere() {
  if (currentArtist) renderArtistAlbums(currentArtist);
  renderRatingsView();
}

starPicker.querySelectorAll(".star").forEach((starEl) => {
  starEl.onclick = async () => {
    const value = Number(starEl.dataset.value);
    const current = ratingsCache[currentAlbum.id]?.rating || 0;
    const newRating = value === current ? 0 : value; // toque na mesma estrela zera a nota
    setStarDisplay(newRating);
    await saveRating(currentAlbum, { rating: newRating });
    refreshBadgesEverywhere();
  };
});

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
  libraryLoadingEl.classList.remove("hidden");
  const loadingLabelEl = libraryLoadingEl.querySelector("span");
  const originalLoadingLabel = loadingLabelEl.textContent;

  try {
    await loadRatings();

    allAlbums = await fetchAllSavedAlbums((countSoFar) => {
      loadingLabelEl.textContent = `Carregando sua biblioteca... (${countSoFar} álbuns)`;
    });

    buildArtistGroups();
    renderArtistList(); // ja dispara a busca de fotos so da pagina atual
  } catch (err) {
    console.error("Erro ao carregar biblioteca:", err);
    libraryEmptyEl.textContent = "Não foi possível carregar sua biblioteca. Tente novamente.";
    libraryEmptyEl.classList.remove("hidden");
  } finally {
    loadingLabelEl.textContent = originalLoadingLabel;
    libraryLoadingEl.classList.add("hidden");
  }
}

start();
