function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371 // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

let cachedStations: any[] | null = null

async function getStations(): Promise<any[]> {
  if (cachedStations) return cachedStations
  try {
    const res = await fetch(
      'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions'
    )
    if (!res.ok) return []
    const data = await res.json()
    cachedStations = data.stations || []
    return cachedStations || []
  } catch (e) {
    console.error('Failed to fetch NOAA stations:', e)
    return []
  }
}

export async function findNearestTideStation(
  lat: number,
  lon: number
): Promise<{ id: string; name: string } | null> {
  const stations = await getStations()
  let nearestStation = null
  let minDistance = Infinity

  for (const station of stations) {
    if (station.lat !== undefined && station.lng !== undefined && station.id) {
      const d = getDistance(lat, lon, station.lat, station.lng)
      if (d < minDistance) {
        minDistance = d
        nearestStation = station
      }
    }
  }

  return nearestStation ? { id: nearestStation.id, name: nearestStation.name } : null
}

export interface WeatherData {
  temperature: number
  precipitation: number
  cloudCover: number
  windSpeed: number
  windDirection: number
}

export async function fetchHistoricalWeather(
  lat: number,
  lng: number,
  date: Date
): Promise<WeatherData | null> {
  try {
    const dateStr = date.toISOString().split('T')[0] // YYYY-MM-DD
    const daysDiff = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)

    // Choose Forecast or Archive API based on how recent the date is
    const isRecent = daysDiff < 85
    const baseUrl = isRecent
      ? 'https://api.open-meteo.com/v1/forecast'
      : 'https://archive-api.open-meteo.com/v1/archive'

    const url = `${baseUrl}?latitude=${lat}&longitude=${lng}&start_date=${dateStr}&end_date=${dateStr}&hourly=temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m&timezone=GMT`

    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`Open-Meteo returned status ${res.status}: ${res.statusText}`)
      return null
    }
    const data = await res.json()

    const flightHour = date.getUTCHours()
    if (!data.hourly || !data.hourly.temperature_2m) return null

    return {
      temperature: data.hourly.temperature_2m[flightHour] ?? 0,
      precipitation: data.hourly.precipitation[flightHour] ?? 0,
      cloudCover: data.hourly.cloud_cover[flightHour] ?? 0,
      windSpeed: data.hourly.wind_speed_10m[flightHour] ?? 0,
      windDirection: data.hourly.wind_direction_10m[flightHour] ?? 0,
    }
  } catch (err) {
    console.error('Error fetching weather:', err)
    return null
  }
}

export interface TidePrediction {
  time: string // ISO string UTC
  value: number // Tide height in feet
}

export async function fetchTidePredictions(
  lat: number,
  lon: number,
  date: Date
): Promise<{ stationName: string; predictions: TidePrediction[] } | null> {
  try {
    const station = await findNearestTideStation(lat, lon)
    if (!station) return null

    const beginDate = new Date(date.getTime() - 24 * 60 * 60 * 1000)
    const endDate = new Date(date.getTime() + 24 * 60 * 60 * 1000)

    const beginYear = beginDate.getUTCFullYear()
    const beginMonth = String(beginDate.getUTCMonth() + 1).padStart(2, '0')
    const beginDay = String(beginDate.getUTCDate()).padStart(2, '0')
    const beginDateStr = `${beginYear}${beginMonth}${beginDay}`

    const endYear = endDate.getUTCFullYear()
    const endMonth = String(endDate.getUTCMonth() + 1).padStart(2, '0')
    const endDay = String(endDate.getUTCDate()).padStart(2, '0')
    const endDateStr = `${endYear}${endMonth}${endDay}`

    const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${beginDateStr}&end_date=${endDateStr}&station=${station.id}&product=predictions&datum=MLLW&time_zone=gmt&units=english&format=json`

    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`NOAA Tides returned status ${res.status}`)
      return null
    }
    const data = await res.json()
    if (!data.predictions) return null

    const predictions: TidePrediction[] = data.predictions.map((p: any) => {
      // NOAA times returned in format: "2026-06-12 00:00" in GMT
      const isoTime = new Date(p.t.replace(' ', 'T') + 'Z').toISOString()
      return {
        time: isoTime,
        value: parseFloat(p.v),
      }
    })

    return {
      stationName: station.name,
      predictions,
    }
  } catch (err) {
    console.error('Error fetching tides:', err)
    return null
  }
}
