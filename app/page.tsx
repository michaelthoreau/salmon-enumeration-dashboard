import Link from 'next/link'
import Image from 'next/image'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { projects } from '@/lib/schema'
import { desc } from 'drizzle-orm'
import CreateProjectForm from '@/app/projects/create-project-form'
import {
  DeleteProjectButton,
  RestoreProjectButton,
  EditProjectButton,
  ProjectCardActions,
} from '@/app/projects/project-actions'
import { AppNavBar } from '@/app/app-navbar'

export default async function Home() {
  const session = await getSession()
  const isAdmin = session?.role === 'admin'

  const allProjects = await db.select().from(projects).orderBy(desc(projects.createdAt))
  const active = allProjects.filter((p) => !p.deletedAt)
  const deleted = allProjects.filter((p) => p.deletedAt)

  return (
    <div className="min-h-screen bg-gray-50">
      <AppNavBar />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-10">
        {/* Project cards */}
        <section>
          <h1 className="text-2xl font-bold text-gray-900 mb-6">Projects</h1>

          {active.length === 0 ? (
            <p className="text-gray-500">No projects yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
              {active.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}/flight-plans`}
                  className="group relative bg-white rounded-2xl border border-gray-200 p-8 hover:border-blue-300 hover:shadow-md transition-all flex flex-col gap-4"
                >
                  <div className="flex-1">
                    <p className="text-xl font-semibold text-gray-900 group-hover:text-blue-600 transition-colors mb-2">
                      {project.name}
                    </p>
                    {project.description && (
                      <p className="text-gray-500 text-sm leading-relaxed">
                        {project.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                    <span className="text-xs text-gray-400">
                      {project.createdAt.toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    {isAdmin && (
                      <ProjectCardActions project={project} />
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Archived (admin only) */}
        {isAdmin && deleted.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-gray-400 mb-3">
              Archived ({deleted.length})
            </h2>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden opacity-60">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {deleted.map((project) => (
                    <tr key={project.id}>
                      <td className="px-6 py-3 text-gray-500">{project.name}</td>
                      <td className="px-6 py-3 text-gray-400">{project.description ?? '—'}</td>
                      <td className="px-6 py-3 text-right">
                        <RestoreProjectButton project={project} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* New project (admin only) */}
        {isAdmin && (
          <section className="border-t border-gray-200 pt-8">
            <h2 className="text-base font-semibold text-gray-700 mb-4">New project</h2>
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <CreateProjectForm />
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

