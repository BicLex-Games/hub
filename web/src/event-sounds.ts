export type EventSound =
  | "participantJoined"
  | "participantLeft"
  | "screenStarted"
  | "screenStopped"
  | "messageReceived";

type Note = {
  frequency: number;
  start: number;
  duration: number;
  gain: number;
};

const SAMPLE_RATE = 48_000;
const cueUrls = new Map<EventSound, string>();

const CUES: Record<EventSound, Note[]> = {
  participantJoined: [
    { frequency: 659.25, start: 0, duration: 0.14, gain: 0.2 },
    { frequency: 987.77, start: 0.11, duration: 0.22, gain: 0.24 },
  ],
  participantLeft: [
    { frequency: 880, start: 0, duration: 0.14, gain: 0.2 },
    { frequency: 587.33, start: 0.11, duration: 0.22, gain: 0.22 },
  ],
  screenStarted: [
    { frequency: 523.25, start: 0, duration: 0.1, gain: 0.17 },
    { frequency: 783.99, start: 0.09, duration: 0.11, gain: 0.19 },
    { frequency: 1174.66, start: 0.18, duration: 0.24, gain: 0.22 },
  ],
  screenStopped: [
    { frequency: 1046.5, start: 0, duration: 0.1, gain: 0.17 },
    { frequency: 698.46, start: 0.09, duration: 0.11, gain: 0.19 },
    { frequency: 466.16, start: 0.18, duration: 0.24, gain: 0.21 },
  ],
  messageReceived: [
    { frequency: 783.99, start: 0, duration: 0.09, gain: 0.14 },
    { frequency: 1046.5, start: 0.07, duration: 0.16, gain: 0.16 },
  ],
};

function writeText(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1)
    view.setUint8(offset + index, value.charCodeAt(index));
}

function cueUrl(cue: EventSound) {
  const cached = cueUrls.get(cue);
  if (cached) return cached;

  const notes = CUES[cue];
  const duration = Math.max(...notes.map((note) => note.start + note.duration));
  const sampleCount = Math.ceil((duration + 0.03) * SAMPLE_RATE);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);

  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(view, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const time = sample / SAMPLE_RATE;
    let value = 0;
    for (const note of notes) {
      const elapsed = time - note.start;
      if (elapsed < 0 || elapsed >= note.duration) continue;
      const attack = Math.min(1, elapsed / 0.012);
      const release = Math.min(1, (note.duration - elapsed) / 0.055);
      const phase = Math.PI * 2 * note.frequency * elapsed;
      value +=
        (Math.sin(phase) + Math.sin(phase * 2) * 0.12) *
        note.gain *
        attack *
        release;
    }
    view.setInt16(
      44 + sample * 2,
      Math.round(Math.max(-1, Math.min(1, value)) * 0x7fff),
      true,
    );
  }

  const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  cueUrls.set(cue, url);
  return url;
}

export function createEventSound(cue: EventSound) {
  const audio = new Audio(cueUrl(cue));
  audio.preload = "auto";
  audio.volume = 0.375;
  return audio;
}
