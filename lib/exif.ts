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

// Walk top-level MP4 box headers (8 bytes each) to find the byte offset and size of `moov`.
// DJI firmware writes moov at the end by default; some firmware/tools move it to the front.
// Walking headers costs at most N small requests (one per top-level box, usually 3–4).
async function findMoovRange(key: string): Promise<{ start: number; size: number } | null> {
  const { contentRange, body: firstChunk } = await getObjectRange(key, 'bytes=0-15')
  const totalMatch = contentRange?.match(/\/(\d+)$/)
  if (!totalMatch) return null
  const fileSize = parseInt(totalMatch[1], 10)

  let offset = 0
  let headerBuf = Buffer.from(firstChunk)

  while (offset < fileSize) {
    if (headerBuf.length < 8) break

    const boxSizeRaw = headerBuf.readUInt32BE(0)
    const boxType = headerBuf.subarray(4, 8).toString('ascii')

    let boxSize: number
    if (boxSizeRaw === 1) {
      if (headerBuf.length < 16) break
      boxSize = Number(headerBuf.readBigUInt64BE(8))
    } else if (boxSizeRaw === 0) {
      boxSize = fileSize - offset
    } else {
      boxSize = boxSizeRaw
    }

    if (boxType === 'moov') return { start: offset, size: boxSize }

    offset += boxSize
    if (offset >= fileSize) break

    const nextEnd = Math.min(offset + 15, fileSize - 1)
    const { body } = await getObjectRange(key, `bytes=${offset}-${nextEnd}`)
    headerBuf = Buffer.from(body)
  }

  return null
}

async function extractVideoDuration(key: string): Promise<number | undefined> {
  try {
    const moov = await findMoovRange(key)
    if (!moov) return undefined

    // mvhd is typically the first child of moov — fetch up to 4 KB of it
    const fetchEnd = Math.min(moov.start + moov.size - 1, moov.start + 4095)
    const { body } = await getObjectRange(key, `bytes=${moov.start}-${fetchEnd}`)
    return parseMvhdDuration(Buffer.from(body)) ?? undefined
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
