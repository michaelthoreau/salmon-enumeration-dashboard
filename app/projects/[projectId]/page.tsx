import { db } from '@/lib/db'
import { projects, flightPlans, flights } from '@/lib/schema'
import { eq, and, isNull, inArray } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { getSession } from '@/lib/session'
import ProjectDashboardView from './dashboard-view'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function ProjectDashboardPage({ params }: PageProps) {
  const { projectId } = await params
  const session = await getSession()
  const isAdmin = session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  const plans = await db
    .select()
    .from(flightPlans)
    .where(and(eq(flightPlans.projectId, projectId), isNull(flightPlans.deletedAt)))

  let allFlights: any[] = []
  if (plans.length > 0) {
    allFlights = await db
      .select()
      .from(flights)
      .where(
        and(
          inArray(
            flights.flightPlanId,
            plans.map((p) => p.id)
          ),
          isNull(flights.deletedAt)
        )
      )
  }

  const formatInTz = (date: Date, tz: string): string => {
    return new Intl.DateTimeFormat('en', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date)
  }

  const dashboardPlans = plans.map((p) => {
    const pFlights = allFlights.filter((f) => f.flightPlanId === p.id)
    const dates = pFlights.map((f) => formatInTz(f.timestamp, project.timezone))
    const uniqueDates = Array.from(new Set(dates))
    return {
      id: p.id,
      name: p.displayName || p.name,
      originalName: p.name,
      displayName: p.displayName,
      description: p.description,
      showOnDashboard: p.showOnDashboard,
      location: p.location,
      flightDates: uniqueDates,
      flightCount: pFlights.length,
    }
  })

  return (
    <ProjectDashboardView
      projectId={projectId}
      projectName={project.name}
      plans={dashboardPlans}
      isAdmin={isAdmin}
    />
  )
}
