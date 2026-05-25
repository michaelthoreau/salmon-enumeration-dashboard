import Image from 'next/image'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex bg-cover bg-center"
      style={{ backgroundImage: "url('/hero_bg.jpg')" }}
    >
      {/* ── Left panel ── */}
      <div className="hidden lg:flex lg:w-3/5 relative flex-col">
        {/* Dark gradient overlay on left side */}
        <div className="absolute inset-0 bg-gradient-to-br from-black/65 via-black/45 to-black/25" />

        {/* Content over the image */}
        <div className="relative z-10 flex flex-col justify-between h-full p-10">
          {/* Top: logo */}
          <div className="bg-white/60 backdrop-blur-md rounded-xl px-4 py-2 inline-flex items-center self-start">
            <Image
              src="/kiwi_logo.webp"
              alt="Project Kiwi"
              width={180}
              height={52}
              className="h-10 w-auto"
              style={{ marginTop: '4px' }}
            />
          </div>

          {/* Bottom: title */}
          <div>
            <h1 className="text-5xl font-bold text-white leading-tight tracking-tight drop-shadow-lg">
              Salmon
              <br />
              Enumeration
              <br />
              Dashboard
            </h1>
            <p className="mt-4 text-white/80 text-lg max-w-sm">
              Drone-based salmon enumeration for Bristol Bay.
            </p>
          </div>
        </div>
      </div>

      {/* ── Right panel: frosted form area ── */}
      <div className="flex-1 flex flex-col relative">
        {/* Soft white wash so the image shows through */}
        <div className="absolute inset-0 bg-white/70 backdrop-blur-sm" />

        {/* Mobile-only header */}
        <div className="relative z-10 lg:hidden flex flex-col items-center gap-3 px-6 pt-12 pb-8 text-center">
          <Image
            src="/kiwi_logo.webp"
            alt="Project Kiwi"
            width={140}
            height={40}
            className="h-9 w-auto"
          />
          <p className="text-lg font-semibold text-gray-800">
            Salmon Enumeration Dashboard
          </p>
        </div>

        <div className="relative z-10 flex-1 flex items-center justify-center px-6 pb-12">
          <div className="w-full max-w-sm">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

