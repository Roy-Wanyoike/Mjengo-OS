'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Button } from '@/frontend/ui/button'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { RadioGroup, RadioGroupItem } from '@/frontend/ui/radio-group'
import { motion } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, Briefcase, Building, Building2, FilePlus, Globe, HardHat,
  Home, Loader2, MapPin, User, Wand2,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/frontend/lib/format'

export type CreateProjectPayload = {
  name: string
  client: string
  clientType: 'diaspora' | 'local' | 'company'
  location: string
  budget: number
  startDate: string
  targetDate: string
  template: 'bungalow' | 'maisonette' | 'duplex' | 'blank'
}

export interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (payload: CreateProjectPayload) => Promise<boolean>
  submitting: boolean
}

const TEMPLATES: Array<{
  value: CreateProjectPayload['template']
  label: string
  desc: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { value: 'bungalow', label: 'Bungalow', desc: '3BR single-storey · 5 phases', icon: Home },
  { value: 'maisonette', label: 'Maisonette', desc: '2-storey · 6 phases incl. structural frame', icon: Building },
  { value: 'duplex', label: 'Duplex', desc: 'Semi-detached · 5 phases', icon: Building2 },
  { value: 'blank', label: 'Blank', desc: 'Start with one empty phase', icon: FilePlus },
]

const dateInputClass =
  'flex h-9 w-full rounded-md border border-stone-200 bg-white px-3 py-1 text-sm text-stone-900 shadow-xs transition-colors file:border-0 file:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50'

function isoDate(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function CreateProjectDialog({ open, onOpenChange, onCreate, submitting }: CreateProjectDialogProps) {
  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState('')
  const [client, setClient] = useState('')
  const [clientType, setClientType] = useState<'diaspora' | 'local' | 'company'>('diaspora')
  const [location, setLocation] = useState('')
  const [budget, setBudget] = useState('')
  const [startDate, setStartDate] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [template, setTemplate] = useState<CreateProjectPayload['template']>('bungalow')
  const [errors, setErrors] = useState<{ name?: string; budget?: string; dates?: string }>({})

  // Reset to fresh defaults each time the dialog opens (today / +120 days).
  // React "adjust state during render" pattern — avoids setState-in-effect.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      const now = new Date()
      const later = new Date(now.getTime() + 120 * 86400000)
      setStep(1)
      setName('')
      setClient('')
      setClientType('diaspora')
      setLocation('')
      setBudget('')
      setStartDate(isoDate(now))
      setTargetDate(isoDate(later))
      setTemplate('bungalow')
      setErrors({})
    }
  }

  const budgetNum = Number(budget)

  function validateStep1(): boolean {
    const e: typeof errors = {}
    if (!name.trim()) e.name = 'Project name is required'
    if (!budget || Number.isNaN(budgetNum) || budgetNum <= 0) e.budget = 'Budget must be greater than 0'
    if (startDate && targetDate && targetDate <= startDate) e.dates = 'Target date must be after start date'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleCreate() {
    if (!validateStep1()) {
      setStep(1)
      return
    }
    const ok = await onCreate({
      name: name.trim(),
      client: client.trim(),
      clientType,
      location: location.trim(),
      budget: Math.round(budgetNum),
      startDate,
      targetDate,
      template,
    })
    if (ok) {
      toast.success('Project created — karibu kazi!')
      onOpenChange(false)
    } else {
      toast.error('Could not create project — check the details and try again')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-stone-900 flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-amber-600" aria-hidden />
            New project · Step {step} of 2
          </DialogTitle>
          <DialogDescription>
            {step === 1 ? 'Site and client basics — you can adjust everything later.' : 'Pick a phase template to scaffold the build plan.'}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <motion.div
            key="step-1"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="grid gap-4 py-1"
          >
            <div className="space-y-2">
              <Label htmlFor="pj-name">Project name *</Label>
              <Input
                id="pj-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Nyumba Yangu Bungalow"
                aria-invalid={Boolean(errors.name)}
              />
              {errors.name && <p className="text-xs text-red-600">{errors.name}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pj-client">Client</Label>
                <Input id="pj-client" value={client} onChange={(e) => setClient(e.target.value)} placeholder="e.g. Wanjiku Family" />
              </div>
              <div className="space-y-2">
                <Label>Client type</Label>
                <Select value={clientType} onValueChange={(v) => setClientType(v as typeof clientType)}>
                  <SelectTrigger aria-label="Client type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="diaspora">
                      <span className="flex items-center gap-2"><Globe className="w-4 h-4 text-amber-600" aria-hidden /> Diaspora</span>
                    </SelectItem>
                    <SelectItem value="local">
                      <span className="flex items-center gap-2"><User className="w-4 h-4 text-stone-500" aria-hidden /> Local</span>
                    </SelectItem>
                    <SelectItem value="company">
                      <span className="flex items-center gap-2"><Briefcase className="w-4 h-4 text-stone-500" aria-hidden /> Company</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pj-location">Location</Label>
              <div className="relative">
                <MapPin className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
                <Input id="pj-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Kitengela, Kajiado" className="pl-9" />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pj-budget">Budget (KSh) *</Label>
              <Input
                id="pj-budget"
                type="number"
                min="1"
                inputMode="numeric"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="e.g. 4500000"
                aria-invalid={Boolean(errors.budget)}
              />
              <div className="flex items-center justify-between text-xs">
                <span className={budget && !Number.isNaN(budgetNum) && budgetNum > 0 ? 'text-stone-600 font-medium' : 'text-stone-400'}>
                  {budget && !Number.isNaN(budgetNum) && budgetNum > 0 ? formatKES(budgetNum) : 'Live preview of total budget'}
                </span>
                {errors.budget && <span className="text-red-600">{errors.budget}</span>}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pj-start">Start date</Label>
                <input id="pj-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={dateInputClass} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pj-target">Target date</Label>
                <input id="pj-target" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={dateInputClass} />
              </div>
            </div>
            {errors.dates && <p className="text-xs text-red-600">{errors.dates}</p>}
          </motion.div>
        ) : (
          <motion.div
            key="step-2"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="py-1"
          >
            <RadioGroup value={template} onValueChange={(v) => setTemplate(v as CreateProjectPayload['template'])} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {TEMPLATES.map(({ value, label, desc, icon: Icon }) => (
                <label
                  key={value}
                  className={`flex items-start gap-3 rounded-xl border p-3.5 cursor-pointer transition-colors min-h-[44px] ${
                    template === value ? 'border-amber-500 bg-amber-50' : 'border-stone-200 bg-white hover:border-stone-300'
                  }`}
                >
                  <span
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                      template === value ? 'bg-amber-500 text-stone-950' : 'bg-stone-100 text-stone-500'
                    }`}
                    aria-hidden
                  >
                    <Icon className="w-4.5 h-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-stone-800">{label}</span>
                    <span className="block text-xs text-stone-500 mt-0.5">{desc}</span>
                  </span>
                  <RadioGroupItem value={value} className="mt-0.5" aria-label={label} />
                </label>
              ))}
            </RadioGroup>
            <p className="text-xs text-stone-400 mt-3">
              Templates create the standard Kenyan phase plan with budgets — rename or add phases any time in Site Plan.
            </p>
          </motion.div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {step === 2 ? (
            <Button variant="outline" onClick={() => setStep(1)} disabled={submitting} className="gap-1.5">
              <ArrowLeft className="w-4 h-4" aria-hidden /> Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          )}
          {step === 1 ? (
            <Button
              onClick={() => validateStep1() && setStep(2)}
              className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
            >
              Continue <ArrowRight className="w-4 h-4" aria-hidden />
            </Button>
          ) : (
            <Button
              onClick={() => void handleCreate()}
              disabled={submitting}
              className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-w-32"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <HardHat className="w-4 h-4" aria-hidden />}
              {submitting ? 'Creating…' : 'Create project'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
