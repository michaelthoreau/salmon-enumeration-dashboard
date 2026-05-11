interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ projectId: string }>
}

export default async function FlightPlansLayout({ children }: LayoutProps) {
  return <>{children}</>
}
