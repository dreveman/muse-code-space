// Companion music profiles from companions/catalog.json: parsing and
// playlist resolution. The server resolves playlist URIs from the catalog
// by companion ID — clients never supply a URI.

export type CompanionMusicPlaylist = { name: string; uri: string; url: string };
export type CompanionMusic = { genre: string; tags: string[]; playlist: CompanionMusicPlaylist | null };

type CatalogEntryLike = {
  id: string;
  music?: {
    genre?: unknown;
    tags?: unknown;
    playlist?: { name?: unknown; uri?: unknown; url?: unknown } | null;
  } | null;
};

const PLAYLIST_URI_RE = /^spotify:playlist:[A-Za-z0-9]+$/;
const PLAYLIST_URL_RE = /^https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]+$/;

/** The entry's music profile, or null when it is missing/malformed. */
export function companionMusicOf(entry: CatalogEntryLike): CompanionMusic | null {
  const music = entry.music;
  if (!music || typeof music.genre !== "string" || !music.genre.trim()) return null;
  const tags = Array.isArray(music.tags)
    ? music.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    : [];
  if (tags.length === 0) return null;
  let playlist: CompanionMusicPlaylist | null = null;
  if (music.playlist) {
    const { name, uri, url } = music.playlist;
    if (
      typeof name === "string" && name.trim()
      && typeof uri === "string" && PLAYLIST_URI_RE.test(uri)
      && typeof url === "string" && PLAYLIST_URL_RE.test(url)
      && url.endsWith(uri.slice("spotify:playlist:".length))
    ) {
      playlist = { name, uri, url };
    }
  }
  return { genre: music.genre, tags, playlist };
}

export type ResolvedCompanionPlaylist =
  | { ok: true; companionId: string; playlistName: string; uri: string }
  | { ok: false; error: string };

/** Resolve a companion's playlist URI from the catalog, by companion ID. */
export function resolveCompanionPlaylist(
  entries: readonly CatalogEntryLike[],
  companionId: string,
): ResolvedCompanionPlaylist {
  const entry = entries.find((item) => item.id === companionId);
  if (!entry) return { ok: false, error: "Unknown companion." };
  const music = companionMusicOf(entry);
  if (!music?.playlist) return { ok: false, error: "That companion has no playlist to play." };
  return { ok: true, companionId: entry.id, playlistName: music.playlist.name, uri: music.playlist.uri };
}
