'use client'

import { Button } from '@/components/ui/button'
import { Camera, HardHat, Mic, Wallet } from 'lucide-react'
import { useT } from '@/lib/i18n/provider'

export interface WelcomeScreenProps {
  onCreate: () => void
  onExploreDemo?: () => void
  demoDataAvailable?: boolean
}

/**
 * First-run welcome screen (W4-I18N — all copy flows through t()).
 */
export function WelcomeScreen({ onCreate, onExploreDemo, demoDataAvailable }: WelcomeScreenProps) {
  const t = useT()

  const FEATURES: Array<{
    icon: React.ComponentType<{ className?: string }>
    title: string
    desc: string
  }> = [
    {
      icon: Camera,
      title: t('welcome.feature.photos'),
      desc: t('welcome.feature.photosDesc'),
    },
    {
      icon: Mic,
      title: t('welcome.feature.voice'),
      desc: t('welcome.feature.voiceDesc'),
    },
    {
      icon: Wallet,
      title: t('welcome.feature.wallet'),
      desc: t('welcome.feature.walletDesc'),
    },
  ]

  return (
    <div className="min-h-screen flex flex-col bg-stone-100">
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-16 flex flex-col items-center justify-center text-center">
        <div className="w-16 h-16 bg-amber-500 rounded-2xl flex items-center justify-center shadow-lg" aria-hidden>
          <HardHat className="w-8 h-8 text-stone-950" />
        </div>

        <h1 className="mt-6 text-3xl font-bold tracking-tight text-stone-900">{t('welcome.title')}</h1>
        <p className="mt-3 text-base sm:text-lg text-stone-600 max-w-xl leading-relaxed">
          {t('welcome.subtitle')}
        </p>

        <section className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4 w-full" aria-label={t('welcome.aria.features')}>
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-xl border border-stone-200 bg-white shadow-sm p-6 text-left">
              <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center" aria-hidden>
                <Icon className="w-5 h-5 text-amber-600" />
              </div>
              <h2 className="mt-3 text-sm font-semibold text-stone-800">{title}</h2>
              <p className="mt-1 text-sm text-stone-600 leading-relaxed">{desc}</p>
            </div>
          ))}
        </section>

        <div className="mt-10 flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          <Button
            onClick={onCreate}
            size="lg"
            className="min-h-11 w-full sm:w-auto px-8 bg-amber-500 hover:bg-amber-600 text-stone-950 font-bold"
          >
            {t('welcome.start')}
          </Button>
          {demoDataAvailable && onExploreDemo && (
            <Button
              onClick={onExploreDemo}
              size="lg"
              variant="ghost"
              className="min-h-11 w-full sm:w-auto text-stone-600 hover:text-stone-900"
            >
              {t('welcome.explore')}
            </Button>
          )}
        </div>
      </main>

      <footer className="mt-auto">
        <p className="text-xs text-stone-400 pb-6 text-center px-4">
          {t('welcome.footer')}
        </p>
      </footer>
    </div>
  )
}
