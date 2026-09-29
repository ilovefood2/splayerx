/**
 * Whether SPlayer may send media information to SPlayer's (upstream) servers.
 *
 * Off: online subtitle search uploaded the file name and a media fingerprint,
 * and watched subtitles were uploaded automatically with the video's hash,
 * whatever the "Upload anonymous data" preference said. Nothing is sent now,
 * and the preference always reads as declined.
 *
 * User-configured services (an AI translation endpoint, model downloads,
 * casting, network shares) are unaffected.
 */
export const SHARE_DATA_WITH_SERVERS = false;
