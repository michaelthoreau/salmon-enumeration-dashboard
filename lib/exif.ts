import ExifReader from 'exifreader'
import { getObjectRange } from './s3'

/**
 * Fetch a small byte range from S3 and extract GPS coordinates.
 * Handles both JPEG EXIF and MP4/MOV video metadata.
 */
export async function extractExifGps(
  key: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const lower = key.toLowerCase()
  const isImage = lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')
  const isVideo = lower.endsWith('.mp4') || lower.endsWith('.mov')

  if (isImage) return extractImageGps(key)
  if (isVideo) return extractVideoGps(key)
  return null
}

async function extractImageGps(
  key: string,
): Promise<{ latitude: number; longitude: number } | null> {
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

async function extractVideoGps(
  key: string,
): Promise<{ latitude: number; longitude: number } | null> {
  try {
    // Try first 256 KB — works for original DJI files (plain-text telemetry near start)
    const { body: body256 } = await getObjectRange(key, 'bytes=0-262143')
    const result256 = parseDjiGps(Buffer.from(body256).toString('ascii'))
    if (result256) return result256

    // Fallback to 2 MB — needed for FFmpeg-re-encoded files where high-bitrate video
    // keyframes push the first mov_text subtitle sample past the 256 KB mark
    const { body: body2m } = await getObjectRange(key, 'bytes=0-2097151')
    return parseDjiGps(Buffer.from(body2m).toString('ascii'))
  } catch (err) {
    console.warn(`[VIDEO GPS] Failed to parse GPS for key ${key}:`, err)
  }
  return null
}
