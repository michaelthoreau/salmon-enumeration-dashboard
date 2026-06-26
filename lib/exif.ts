import ExifReader from 'exifreader'
import { getObjectRange } from './s3'

export interface VideoMeta {
  latitude: number
  longitude: number
  durationSeconds?: number
}

export async function extractExifGps(
  key: string,
): Promise<VideoMeta | null> {
  const lower = key.toLowerCase()
  const isImage = lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')
  const isVideo = lower.endsWith('.mp4') || lower.endsWith('.mov')

  if (isImage) return extractImageGps(key)
  if (isVideo) return extractVideoMeta(key)
  return null
}

async function extractImageGps(
  key: string,
): Promise<VideoMeta | null> {
  try {
    const { body } = await getObjectRange(key, 'bytes=0-65535')
    const tags = ExifReader.load(Buffer.from(body), { expanded: true })

    if (
      tags.gps &&
      typeof tags.gps.Latitude === 'number' &&
      typeof tags.gps.Longitude === 'number'
    ) {
      return {
        latitude: tags.gps.Latitude,
        longitude: tags.gps.Longitude,
      }
    }
  } catch (err) {
    console.warn(`[EXIF] Failed to parse GPS for key ${key}:`, err)
  }
  return null
}

function parseDjiGps(text: string): { latitude: number; longitude: number } | null {
  const latMatch = text.match(/\[latitude:\s*([-\d.]+)\]/)
  const lngMatch = text.match(/\[longitude:\s*([-\d.]+)\]/)
  if (!latMatch || !lngMatch) return null
  const latitude = parseFloat(latMatch[1])
  const longitude = parseFloat(lngMatch[1])
  if (isNaN(latitude) || isNaN(longitude) || latitude === 0 || longitude === 0) return null
  return { latitude, longitude }
}

// Parse duration from MP4 mvhd box. Works for DJI originals (moov near start)
// and re-encoded files (moov near end — caller provides the right buffer).
function parseMvhdDuration(buf: Buffer): number | null {
  const mvhdIdx = buf.indexOf(Buffer.from('mvhd'))
  if (mvhdIdx < 0) return null
  try {
    const version = buf[mvhdIdx + 4]
    let timescale: number, duration: number
    if (version === 1) {
      if (mvhdIdx + 32 > buf.length) return null
      timescale = buf.readUInt32BE(mvhdIdx + 20)
      duration = Number(buf.readBigUInt64BE(mvhdIdx + 24))
    } else {
      if (mvhdIdx + 20 > buf.length) return null
      timescale = buf.readUInt32BE(mvhdIdx + 12)
      duration = buf.readUInt32BE(mvhdIdx + 16)
    }
    if (!timescale || !duration) return null
    return duration / timescale
  } catch {
    return null
  }
}

async function extractVideoMeta(key: string): Promise<VideoMeta | null> {
  try {
    // Read first 2 MB: covers GPS for both original DJI (first 256 KB) and
    // re-encoded files, plus the mvhd box for DJI originals (moov at start).
    const { body: body2m } = await getObjectRange(key, 'bytes=0-2097151')
    const buf2m = Buffer.from(body2m)

    const gps = parseDjiGps(buf2m.toString('ascii'))
    let durationSeconds = parseMvhdDuration(buf2m) ?? undefined

    // For re-encoded files, moov is at the end — try the last 200 KB for mvhd.
    if (!durationSeconds) {
      try {
        const { body: bodyEnd, contentLength } = await getObjectRange(key, 'bytes=-204800')
        if (contentLength) {
          durationSeconds = parseMvhdDuration(Buffer.from(bodyEnd)) ?? undefined
        }
      } catch { /* best-effort */ }
    }

    if (!gps) return null
    return { ...gps, durationSeconds }
  } catch (err) {
    console.warn(`[VIDEO META] Failed to parse metadata for key ${key}:`, err)
  }
  return null
}
