import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { fetchHistoricalWeather, fetchTidePredictions } from '@/lib/weather-tides'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return new NextResponse('Unauthorized', { status: 401 })

  const latStr = request.nextUrl.searchParams.get('lat')
  const lngStr = request.nextUrl.searchParams.get('lng')
  const timestampStr = request.nextUrl.searchParams.get('timestamp')

  if (!latStr || !lngStr || !timestampStr) {
    return new NextResponse('Missing parameters', { status: 400 })
  }

  const lat = parseFloat(latStr)
  const lng = parseFloat(lngStr)
  const date = new Date(timestampStr)

  if (Number.isNaN(lat) || Number.isNaN(lng) || Number.isNaN(date.getTime())) {
    return new NextResponse('Invalid parameters', { status: 400 })
  }

  try {
    const [weather, tides] = await Promise.all([
      fetchHistoricalWeather(lat, lng, date),
      fetchTidePredictions(lat, lng, date),
    ])

    return NextResponse.json({ weather, tides })
  } catch (err) {
    console.error('[Weather-Tides API] Error:', err)
    return new NextResponse(`Error fetching weather/tides: ${String(err)}`, { status: 502 })
  }
}
