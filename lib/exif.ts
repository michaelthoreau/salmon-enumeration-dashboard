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

async function extractVideoGps(
  key: string,
): Promise<{ latitude: number; longitude: number } | null> {
  try {
    // DJI embeds telemetry in the first ~200KB of the video file
    const { body } = await getObjectRange(key, 'bytes=0-262143')
    const buf = Buffer.from(body)
    const text = buf.toString('ascii')

    // DJI telemetry format: [latitude: 59.214246] [longitude: -158.539621]
    const latMatch = text.match(/\[latitude:\s*([-\d.]+)\]/)
    const lngMatch = text.match(/\[longitude:\s*([-\d.]+)\]/)

    if (latMatch && lngMatch) {
      const latitude = parseFloat(latMatch[1])
      const longitude = parseFloat(lngMatch[1])
      if (!isNaN(latitude) && !isNaN(longitude) && latitude !== 0 && longitude !== 0) {
        return { latitude, longitude }
      }
    }
  } catch (err) {
    console.warn(`[VIDEO GPS] Failed to parse GPS for key ${key}:`, err)
  }
  return null
}
