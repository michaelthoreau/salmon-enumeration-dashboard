'use client'

import { useActionState } from 'react'
import { createProject } from '@/app/actions/projects'
import { TIMEZONE_OPTIONS } from '@/lib/timezones'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

export default function CreateProjectForm() {
  const [state, action, pending] = useActionState(createProject, null)

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-3">
        <Input
          name="name"
          required
          placeholder="project-name"
          className="flex-1"
        />
        <Input
          name="description"
          placeholder="Description (optional)"
          className="flex-1"
        />
        <Select name="timezone" defaultValue="Pacific/Auckland">
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Timezone" />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONE_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create project'}
        </Button>
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state?.success && <p className="text-sm text-green-600">{state.success}</p>}
    </form>
  )
}
