// Offscreen document: the MV3-sanctioned way to play audio from a service worker.
// A page-injected AudioContext is blocked by autoplay policy when a nag fires on a
// timer (no user gesture); an offscreen document created for AUDIO_PLAYBACK is not.

interface ChimeMessage {
  type?: string
  kind?: "intervention" | "celebration"
}

let ctx: AudioContext | null = null

function playChime(kind: "intervention" | "celebration"): void {
  ctx ??= new AudioContext()
  void ctx.resume?.()
  const ac = ctx
  const beep = (freq: number, at: number, dur: number): void => {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = "sine"
    osc.frequency.value = freq
    const t0 = ac.currentTime + at
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(gain).connect(ac.destination)
    osc.start(t0)
    osc.stop(t0 + dur)
  }
  // Celebration: a rising major third (warm). Intervention: a gentle down-step (a nudge).
  const notes = kind === "celebration" ? [659.25, 987.77] : [783.99, 587.33]
  beep(notes[0], 0, 0.14)
  beep(notes[1], 0.13, 0.18)
}

chrome.runtime.onMessage.addListener((message: ChimeMessage) => {
  if (message?.type === "kbz-chime") {
    try {
      playChime(message.kind === "celebration" ? "celebration" : "intervention")
    } catch {
      // No audio device / context failure — nothing to do.
    }
  }
})
