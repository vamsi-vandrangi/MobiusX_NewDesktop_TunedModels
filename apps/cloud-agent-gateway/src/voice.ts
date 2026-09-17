import type { TranscribeResponse } from "@mobiusx/protocol";

// whisper-large-v3-turbo: Groq's fastest hosted Whisper variant, still
// multilingual (unlike the English-only distil-whisper model) -- a
// reasonable default for a "reduce lag" input method. Verified against
// Groq's own docs (console.groq.com/docs/speech-to-text) at the time this
// was written; Groq does deprecate/rotate models over time (see
// console.groq.com/docs/deprecations), same caveat as groqRunner.ts.
const TRANSCRIBE_MODEL = "whisper-large-v3-turbo";

const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export function voiceUnavailableReason(): string {
  return "requires GROQ_API_KEY (get one free at console.groq.com/keys) -- see apps/cloud-agent-gateway/README.md";
}

export function voiceAvailable(): boolean {
  // Read fresh, never cached -- same reasoning as openAiCompatibleRunner.ts's
  // apiKeyEnvVar: a .env picked up after startup (index.ts's
  // process.loadEnvFile) should be honored without a restart... well, this
  // process still needs a restart to re-run loadEnvFile itself, but at
  // least this never goes stale *within* one run from a cached boolean.
  return Boolean(process.env.GROQ_API_KEY);
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm"; // MediaRecorder's default in Chromium/Electron
}

/**
 * Voice input for the AI Assistant's prompt box (see TranscribeRequest's
 * doc comment in packages/protocol/src/cloud.ts for why this exists as a
 * real server call instead of the browser's Web Speech API). Reuses
 * GROQ_API_KEY -- Groq's free tier already backs this gateway's fastest
 * text model, and its hosted Whisper endpoint is a genuine, working
 * speech-to-text service rather than a stub.
 */
export async function transcribeAudio(audioBase64: string, mimeType: string): Promise<TranscribeResponse> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error(voiceUnavailableReason());

  let buffer: Buffer;
  try {
    buffer = Buffer.from(audioBase64, "base64");
  } catch {
    throw new Error("audio field was not valid base64");
  }
  if (buffer.length === 0) throw new Error("audio field was empty");

  const form = new FormData();
  // Buffer's underlying ArrayBufferLike can widen to SharedArrayBuffer,
  // which BlobPart does not accept -- copy into a plain Uint8Array first.
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType || "audio/webm" }), `voice-input.${extensionFor(mimeType)}`);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");

  const res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq transcription API returned ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as { text?: string };
  return { text: (json.text ?? "").trim() };
}
