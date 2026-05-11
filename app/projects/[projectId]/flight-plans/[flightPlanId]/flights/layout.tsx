interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ projectId: string; flightPlanId: string }>
}

export default async function FlightsLayout({ children }: LayoutProps) {
  return <>{children}</>
}
