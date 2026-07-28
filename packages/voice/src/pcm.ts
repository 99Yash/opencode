export const PCM_SAMPLE_RATE = 24_000
export const PCM_BYTES_PER_MS = (PCM_SAMPLE_RATE * 2) / 1_000
export const PCM_METER_FRAME_MS = 33

export function pcmLevel(bytes: Buffer) {
  const samples = Math.floor(bytes.length / 2)
  if (samples === 0) return 0
  const stride = Math.max(1, Math.floor(samples / 1_200))
  let energy = 0
  let count = 0
  for (let index = 0; index < samples; index += stride) {
    const sample = bytes.readInt16LE(index * 2) / 32_768
    energy += sample * sample
    count += 1
  }
  const rms = Math.sqrt(energy / count)
  if (rms < 0.008) return 0
  return Math.min(1, Math.sqrt((rms - 0.008) / 0.18))
}
