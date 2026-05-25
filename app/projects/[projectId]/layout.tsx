import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { projects } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import ProjectNav from './project-nav'

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ projectId: string }>
}

export default async function ProjectLayout({ children, params }: LayoutProps) {
  const { projectId } = await params
  const session = await getSession()
  const isAdmin = session?.role === 'admin'

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.deletedAt) notFound()

  return (
    <div>
      <ProjectNav
        projectId={projectId}
        projectName={project.name}
        projectDescription={project.description ?? null}
        isAdmin={isAdmin}
        project={project}
      />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </div>
    </div>
  )
}
