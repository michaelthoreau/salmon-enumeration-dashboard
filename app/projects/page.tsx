import Link from 'next/link'
import { db } from '@/lib/db'
import { projects } from '@/lib/schema'
import { desc } from 'drizzle-orm'
import { getSession } from '@/lib/session'
import CreateProjectForm from './create-project-form'
import { DeleteProjectButton, RestoreProjectButton, EditProjectButton } from './project-actions'

export default async function ProjectsPage() {
  const session = await getSession()
  const isAdmin = session?.role === 'admin'

  const allProjects = await db.select().from(projects).orderBy(desc(projects.createdAt))
  const active = allProjects.filter((p) => !p.deletedAt)
  const deleted = allProjects.filter((p) => p.deletedAt)

  return (
    <div className="space-y-8">
      {isAdmin && (
        <details className="group">
          <summary className="text-sm text-gray-400 hover:text-gray-600 cursor-pointer select-none w-fit">
            + New project
          </summary>
          <div className="mt-4 bg-white rounded-xl border border-gray-200 p-6">
            <CreateProjectForm />
          </div>
        </details>
      )}

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Projects{' '}
          <span className="text-sm font-normal text-gray-500">({active.length})</span>
        </h2>
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {active.length === 0 ? (
            <p className="text-sm text-gray-500 p-6">No projects yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Name</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Description</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Created</th>
                  {isAdmin && <th className="px-6 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {active.map((project) => (
                  <tr key={project.id}>
                    <td className="px-6 py-3">
                      <Link
                        href={`/projects/${project.id}/flight-plans`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {project.name}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-gray-500">
                      {project.description ?? '—'}
                    </td>
                    <td className="px-6 py-3 text-gray-500">
                      {project.createdAt.toLocaleDateString()}
                    </td>
                    {isAdmin && (
                      <td className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <EditProjectButton project={project} />
                          <DeleteProjectButton project={project} />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {isAdmin && deleted.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-500 mb-4">
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
    </div>
  )
}
