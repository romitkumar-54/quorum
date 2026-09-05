import type { Metadata } from 'next'
import { Archivo, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'

/** Grotesque with signage roots — equipment labelling, not a UI default. */
const archivo = Archivo({
  variable: '--font-archivo',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

/** Timecode and counters only. Every edit suite in the world sets these mono. */
const plexMono = IBM_Plex_Mono({
  variable: '--font-plex',
  subsets: ['latin'],
  weight: ['400', '500'],
})

export const metadata: Metadata = {
  title: 'Quorum — coordinated AI interview panel',
  description:
    'Three AI interviewers in one voice channel, and a coordinator deciding who speaks. Built for the EchoSphere hackathon by team Newbiezz.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
