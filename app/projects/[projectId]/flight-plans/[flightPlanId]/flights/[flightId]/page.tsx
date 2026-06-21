import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { flights, flightPlans, projects, files as filesTable, odmTasks, georefTasks } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import { listFlightObjects, createPresignedGetUrl } from '@/lib/s3'
import { fetchHistoricalWeather, fetchTidePredictions } from '@/lib/weather-tides'
import { getAnnotations } from '@/app/actions/annotations'

import FlightSplitView from './flight-split-view'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ projectId: string; flightPlanId: string; flightId: string }>
  searchParams: Promise<{ from?: string; returnTo?: string }>
}

function formatInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).format(date)
}

function toLocalInputValue(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export default async function FlightDetailPage({ params, searchParams }: PageProps) {
  const { projectId, flightPlanId, flightId } = await params
  const { from, returnTo } = await searchParams
  const session = await getSession()
  const canWrite = session?.role === 'read-write' || session?.role === 'admin'



  const [flight] = await db.select().from(flights).where(eq(flights.id, flightId))
  if (!flight || flight.deletedAt) notFound()

  const [flightPlan] = await db.select().from(flightPlans).where(eq(flightPlans.id, flightPlanId))
  if (!flightPlan || flightPlan.deletedAt) notFound()

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  // DB is the source of truth for file listing
  const dbFiles = await db.select().from(filesTable).where(eq(filesTable.flightId, flightId))

  // If any file is missing its size (e.g. legacy files), get file sizes from S3
  let s3Objects: { key: string; size: number; lastModified: Date; etag: string }[] = []
  if (dbFiles.some((f) => f.size === null)) {
    try {
      s3Objects = await listFlightObjects(projectId, flightPlanId, flightId)
      
      // Update missing sizes in DB asynchronously/synchronously
      for (const file of dbFiles) {
        if (file.size === null) {
          const matched = s3Objects.find((o) => o.key === file.key)
          if (matched) {
            file.size = matched.size
            await db.update(filesTable).set({ size: matched.size }).where(eq(filesTable.id, file.id))
          }
        }
      }
    } catch (err) {
      console.error('Failed to list S3 objects to recover missing file sizes:', err)
    }
  }

  const splitByKey = Object.fromEntries(dbFiles.map(f => [f.key, f.split ?? null]))

  // Most recent ODM task for this flight (if any)
  const [latestOdmTask] = await db
    .select()
    .from(odmTasks)
    .where(eq(odmTasks.flightId, flightId))
    .orderBy(desc(odmTasks.createdAt))
    .limit(1)

  // Most recent Georef task for this flight (if any)
  const [latestGeorefTask] = await db
    .select()
    .from(georefTasks)
    .where(eq(georefTasks.flightId, flightId))
    .orderBy(desc(georefTasks.createdAt))
    .limit(1)

  // Filter out any generated outputs from the main file list
  const displayObjects = dbFiles.filter((o) => !o.key.includes('/outputs/') && !o.key.includes('/odm/') && !o.key.includes('/georef/'))

  // Find processed outputs in S3 list, fallback to db records if S3 fails
  const geotiffKey = s3Objects.find((o) => o.key.includes('/outputs/') && (o.key.endsWith('.tif') || o.key.endsWith('.tiff')))?.key
    || s3Objects.find((o) => o.key.includes('/odm/') && (o.key.endsWith('.tif') || o.key.endsWith('.tiff')))?.key
    || latestOdmTask?.outputKey
    || s3Objects.find((o) => o.key.includes('/georef/') && (o.key.endsWith('.tif') || o.key.endsWith('.tiff')))?.key
    || latestGeorefTask?.outputKey

  const reportPdfKey = s3Objects.find((o) => o.key.includes('/odm/') && o.key.endsWith('.pdf'))?.key || latestOdmTask?.reportKey

  let geotiffDownloadUrl = ''
  let reportPdfViewUrl = ''

  if (geotiffKey) {
    try {
      geotiffDownloadUrl = await createPresignedGetUrl(geotiffKey, 3600, 'attachment')
    } catch (err) {
      console.error('Failed to presign geotiff:', err)
    }
  }
  if (reportPdfKey) {
    try {
      reportPdfViewUrl = await createPresignedGetUrl(reportPdfKey, 3600, 'inline')
    } catch (err) {
      console.error('Failed to presign report pdf:', err)
    }
  }

  // 1. Calculate centroid coordinates from S3 flight images database list or flightPlan location
  const coordsWithGps = dbFiles.filter((f) => f.latitude !== null && f.longitude !== null)
  let lat = 61.2383 // Anchorage default lat
  let lng = -149.8883 // Anchorage default lng
  let hasCoordinates = false

  if (coordsWithGps.length > 0) {
    const sumLat = coordsWithGps.reduce((acc, f) => acc + (f.latitude || 0), 0)
    const sumLng = coordsWithGps.reduce((acc, f) => acc + (f.longitude || 0), 0)
    lat = sumLat / coordsWithGps.length
    lng = sumLng / coordsWithGps.length
    hasCoordinates = true
  } else if (flightPlan.location) {
    try {
      const geom = JSON.parse(flightPlan.location)
      if (geom.type === 'Point') {
        lng = geom.coordinates[0]
        lat = geom.coordinates[1]
        hasCoordinates = true
      } else if (geom.type === 'Polygon') {
        const ring = geom.coordinates[0] || []
        if (ring.length > 0) {
          const sumLat = ring.reduce((acc: number, pt: number[]) => acc + pt[1], 0)
          const sumLng = ring.reduce((acc: number, pt: number[]) => acc + pt[0], 0)
          lat = sumLat / ring.length
          lng = sumLng / ring.length
          hasCoordinates = true
        }
      }
    } catch (e) {
      console.error('Failed to parse flightPlan location coordinates:', e)
    }
  }

  // 2. Fetch weather and tides in parallel using constant location coordinates
  let weatherData = null
  let tideData = null
  let annotationsList: any[] = []

  try {
    const [weather, tides, annos] = await Promise.all([
      fetchHistoricalWeather(59.1828446, -158.5463867, flight.timestamp),
      fetchTidePredictions(59.1828446, -158.5463867, flight.timestamp),
      getAnnotations(flightId),
    ])
    weatherData = weather
    tideData = tides
    annotationsList = annos as any[]
  } catch (err) {
    console.error('Failed to fetch weather/tide/annotations data:', err)
  }

  return (
    <FlightSplitView
      projectId={projectId}
      flightPlanId={flightPlanId}
      flightId={flightId}
      flight={flight}
      flightPlan={flightPlan}
      project={project}
      initialAnnotations={annotationsList}
      displayObjects={displayObjects.map((o) => ({
        id: o.id,
        key: o.key,
        size: o.size ?? 0,
        lastModifiedIso: o.uploadedAt.toISOString(),
        etag: o.etag,
        split: splitByKey[o.key] ?? null,
        latitude: o.latitude,
        longitude: o.longitude,
      }))}
      geotiffKey={geotiffKey ?? null}
      reportPdfKey={reportPdfKey ?? null}
      geotiffDownloadUrl={geotiffDownloadUrl}
      reportPdfViewUrl={reportPdfViewUrl}
      latestOdmTask={latestOdmTask ?? null}
      latestGeorefTask={latestGeorefTask ?? null}
      splitByKey={splitByKey}
      canWrite={canWrite}
      formattedTime={formatInTz(flight.timestamp, project.timezone)}
      localTimestamp={toLocalInputValue(flight.timestamp, project.timezone)}
      weather={weatherData}
      tides={tideData}
      from={from}
      returnTo={returnTo}
    />
  )
}
