#!/usr/bin/env node
// Speaks synced lyrics of the track playing in the macOS Spotify app, using the system TTS.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const OFFSET_MS = Number(process.env.OFFSET_MS ?? 0); // speak this many ms earlier (TTS has startup delay)
const MAX_LATE_MS = 1000;
const SEEK_MS = 1000;
const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Checks "is running" first: `tell application "Spotify"` would otherwise launch it.
const SCRIPT = `if application "Spotify" is running then
tell application "Spotify"
if player state is stopped then return "stopped"
set t to current track
return (player state as string) & "|" & player position & "|" & (id of t) & "|" & (name of t) & "|" & (artist of t) & "|" & (duration of t)
end tell
else
return "stopped"
end if`;

interface Track { id: string; name: string; artist: string; durationMs: number; progressMs: number; playing: boolean }

async function poll(): Promise<Track | null> {
  const { stdout } = await run('osascript', ['-e', SCRIPT], { timeout: 3000 });
  if (stdout.trim() === 'stopped') return null;
  const p = stdout.trim().split('|'); // names may contain "|": fixed fields come from both ends
  const [state, pos, uri] = p;
  if (!uri.startsWith('spotify:track:')) return null; // podcasts, local files
  return {
    id: uri, name: p.slice(3, -2).join('|'), artist: p[p.length - 2], durationMs: Number(p[p.length - 1]),
    progressMs: Math.round(Number(pos.replace(',', '.')) * 1000), // some locales use a decimal comma
    playing: state === 'playing',
  };
}

type Line = { timeMs: number; text: string };

function parseLrc(lrc: string): Line[] {
  return lrc.split('\n').flatMap((l) => {
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(l.trim());
    const text = m?.[3].trim() ?? '';
    return m && /[\p{L}\p{N}]/u.test(text) ? [{ timeMs: (Number(m[1]) * 60 + Number(m[2])) * 1000, text }] : [];
  });
}

/** LRCLIB: open, keyless synced-lyrics API. Matches on duration since album names vary. */
async function findLyrics(t: Track): Promise<Line[]> {
  const q = new URLSearchParams({ track_name: t.name, artist_name: t.artist });
  const r = await fetch(`https://lrclib.net/api/search?${q}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`lrclib ${r.status}`);
  const hit = ((await r.json()) as any[]).find((h) => h.syncedLyrics && Math.abs(h.duration * 1000 - t.durationMs) <= 3000);
  return hit ? parseLrc(hit.syncedLyrics) : [];
}

let speaking: ChildProcess | undefined;
function speak(text: string) {
  console.log(text);
  speaking?.kill(); // cut off the previous line so speech stays in time
  speaking = spawn('say', [text], { stdio: 'ignore' });
}

let trackId = '', lines: Line[] = [], cursor = 0;
let sample: { progressMs: number; playing: boolean; at: number } | null = null;
const position = (now = performance.now()) => sample && sample.progressMs + (sample.playing ? now - sample.at : 0);
const cursorAt = (pos: number) => { const i = lines.findIndex((l) => l.timeMs - OFFSET_MS >= pos); return i < 0 ? lines.length : i; };

let lastPoll = 0;
for (;;) {
  const now = performance.now();
  if (now - lastPoll >= 1000) {
    lastPoll = now;
    try {
      const t = await poll();
      const at = (now + performance.now()) / 2; // anchor at the request midpoint
      if (!t) { trackId = ''; sample = null; lines = []; }
      else {
        const expected = t.id === trackId ? position(at) : null;
        sample = { progressMs: t.progressMs, playing: t.playing, at };
        if (t.id !== trackId) {
          trackId = t.id; lines = []; cursor = 0;
          console.log(`♪ ${t.artist} – ${t.name}`);
          findLyrics(t).then((l) => {
            if (trackId !== t.id) return; // user already skipped
            console.log(l.length ? `${l.length} lines` : 'no synced lyrics');
            lines = l; cursor = cursorAt(position() ?? 0);
          }).catch((e) => console.error('lyrics failed:', e.message));
        } else if (expected === null || Math.abs(t.progressMs - expected) > SEEK_MS) cursor = cursorAt(t.progressMs);
      }
    } catch (e) { console.error('spotify poll failed:', (e as Error).message); }
  }
  const pos = sample?.playing ? position() : null;
  while (pos !== null && cursor < lines.length && lines[cursor].timeMs - OFFSET_MS <= pos) {
    const line = lines[cursor++];
    if (pos - (line.timeMs - OFFSET_MS) <= MAX_LATE_MS) speak(line.text);
  }
  await sleep(50);
}
