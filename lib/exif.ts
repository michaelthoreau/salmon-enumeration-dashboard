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
      // v1: creation(8) + modification(8) + timescale(4) + duration(8)
      if (mvhdIdx + 36 > buf.length) return null
      timescale = buf.readUInt32BE(mvhdIdx + 24)
      duration = Number(buf.readBigUInt64BE(mvhdIdx + 28))
    } else {
      // v0: creation(4) + modification(4) + timescale(4) + duration(4)
      if (mvhdIdx + 24 > buf.length) return null
      timescale = buf.readUInt32BE(mvhdIdx + 16)
      duration = buf.readUInt32BE(mvhdIdx + 20)
    }
    if (!timescale || !duration) return null
    return duration / timescale
  } catch {
    return null
  }
}

async function extractVideoDuration(key: string): Promise<number | undefined> {
  try {
    // Try first 2 MB — moov is here for DJI originals (moov-at-start)
    const { body: bodyStart } = await getObjectRange(key, 'bytes=0-2097151')
    const dur = parseMvhdDuration(Buffer.from(bodyStart))
    if (dur) return dur

    // For FFmpeg re-encoded files moov is at the end; mvhd can be ~650 KB in from EOF
    const { body: bodyEnd } = await getObjectRange(key, 'bytes=-1048576')
    return parseMvhdDuration(Buffer.from(bodyEnd)) ?? undefined
  } catch {
    return undefined
  }
}

async function extractVideoMeta(key: string): Promise<VideoMeta | null> {
  try {
    const { body: body2m } = await getObjectRange(key, 'bytes=0-2097151')
    const buf2m = Buffer.from(body2m)

    const gps = parseDjiGps(buf2m.toString('ascii'))
    const durationSeconds = await extractVideoDuration(key)

    if (!gps) return null
    return { ...gps, durationSeconds }
  } catch (err) {
    console.warn(`[VIDEO META] Failed to parse metadata for key ${key}:`, err)
  }
  return null
}

export async function extractVideoDurationOnly(key: string): Promise<number | undefined> {
  return extractVideoDuration(key)
}
