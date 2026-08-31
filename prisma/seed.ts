import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function daysAgo(n: number, hour = 9, minute = 0) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

function isoDate(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

/** The last n calendar weekdays as [daysAgoIndex, isoDate] (index 0 = most recent weekday). */
function lastWeekdays(n: number): Array<[number, string]> {
  const out: Array<[number, string]> = []
  for (let i = 0; out.length < n && i < n * 2 + 10; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) out.push([i, d.toISOString().slice(0, 10)])
  }
  return out
}

async function main() {
  // wipe in FK-safe order (children, then parents)
  await db.notification.deleteMany()
  await db.siteZone.deleteMany()
  await db.photoComment.deleteMany()
  await db.variationOrder.deleteMany()
  await db.milestone.deleteMany()
  await db.escrowWallet.deleteMany()
  await db.auditEvent.deleteMany()
  await db.recap.deleteMany()
  await db.transaction.deleteMany()
  await db.alert.deleteMany()
  await db.sitePhoto.deleteMany()
  await db.consumption.deleteMany()
  await db.delivery.deleteMany()
  await db.attendance.deleteMany()
  await db.material.deleteMany()
  await db.worker.deleteMany()
  await db.task.deleteMany()
  await db.phase.deleteMany()
  await db.project.deleteMany()

  // ==========================================================================
  // PROJECT 1 — Nyumba Yangu — 3BR Bungalow (existing demo data, preserved)
  // ==========================================================================
  const project = await db.project.create({
    data: {
      name: 'Nyumba Yangu — 3BR Bungalow',
      client: 'Amina & Yusuf (Diaspora · Boston)',
      clientType: 'diaspora',
      location: 'Kitengela, Kajiado County',
      budget: 4500000,
      startDate: daysAgo(46),
      targetDate: daysAgo(-104),
      status: 'active',
      createdAt: daysAgo(46, 8),
    },
  })

  // ---------- Phases & tasks ----------
  const phaseDefs = [
    { name: 'Site Prep & Foundation', budget: 900000, status: 'done', progressManual: 100, tasks: [
      ['Site clearing & setting out', 'done', 100],
      ['Excavation of foundation trenches', 'done', 100],
      ['Blinding & foundation walls', 'done', 100],
      ['Backfilling & compaction', 'done', 100],
      ['Damp proof membrane (DPM)', 'done', 100],
    ]},
    { name: 'Walling', budget: 1200000, status: 'in_progress', progressManual: 62, tasks: [
      ['Stone walling — courses 1-8', 'done', 100],
      ['Window & door lintels', 'done', 100],
      ['Stone walling — courses 9-14', 'in_progress', 60],
      ['Ring beam shuttering & casting', 'pending', 0],
    ]},
    { name: 'Roofing', budget: 800000, status: 'pending', progressManual: 0, tasks: [
      ['Roof trusses & purlins', 'pending', 0],
      ['Mabati (iron sheets) installation', 'pending', 0],
      ['Ridge caps & fascia board', 'pending', 0],
    ]},
    { name: 'Plumbing & Electrical', budget: 600000, status: 'pending', progressManual: 0, tasks: [
      ['Conduit & sleeve pipe installation', 'pending', 0],
      ['Plumbing rough-in', 'pending', 0],
      ['Electrical wiring', 'pending', 0],
    ]},
    { name: 'Finishing', budget: 1000000, status: 'pending', progressManual: 0, tasks: [
      ['Plastering (inside & outside)', 'pending', 0],
      ['Floor screed & tiling', 'pending', 0],
      ['Painting & fittings', 'pending', 0],
      ['External works & cleaning', 'pending', 0],
    ]},
  ]

  const phases: Record<string, { id: string }> = {}
  for (let i = 0; i < phaseDefs.length; i++) {
    const p = phaseDefs[i]
    const phase = await db.phase.create({
      data: {
        projectId: project.id,
        name: p.name,
        order: i + 1,
        budget: p.budget,
        status: p.status,
        progressManual: p.progressManual,
      },
    })
    phases[p.name] = phase
    for (const [title, status, progress] of p.tasks) {
      await db.task.create({
        data: { phaseId: phase.id, title, status: status as string, progress: progress as number },
      })
    }
  }

  // ---------- Workers (fundis) ----------
  const workerDefs = [
    ['Mwangi Kariuki', 'Foreman (Mkuu wa Site)', '0722456781', 2000],
    ['Otieno Odhiambo', 'Fundi wa Mawe (Mason)', '0733112233', 1500],
    ['Kevin Mutiso', 'Fundi wa Chuma (Steel Fixer)', '0714556677', 1400],
    ['Bernard Kimani', 'Fundi wa Mbao (Carpenter)', '0720998877', 1400],
    ['Ali Hassan', 'Plumber', '0790443322', 1600],
    ['Joseph Mwenda', 'Mtumishi (Labourer)', '0757889900', 800],
    ['Peter Ochieng', 'Mtumishi (Labourer)', '0719221144', 800],
  ]
  const workers: Record<string, string> = {}
  for (const [name, role, phone, rate] of workerDefs) {
    const w = await db.worker.create({
      data: { projectId: project.id, name, role, phone, dailyRate: rate },
    })
    workers[name] = w.id
  }

  // ---------- Attendance: last 8 working days ----------
  // Day 0 = today: everyone present except Peter (half day)
  const attendancePlan: Record<number, Array<[string, string, string]>> = {
    0: [
      ['Mwangi Kariuki', 'present', 'geofence'],
      ['Otieno Odhiambo', 'present', 'geofence'],
      ['Kevin Mutiso', 'present', 'geofence'],
      ['Bernard Kimani', 'present', 'geofence'],
      ['Ali Hassan', 'present', 'geofence'],
      ['Joseph Mwenda', 'present', 'ussd'],
      ['Peter Ochieng', 'half_day', 'ussd'],
    ],
    1: [
      ['Mwangi Kariuki', 'present', 'geofence'],
      ['Otieno Odhiambo', 'present', 'geofence'],
      ['Kevin Mutiso', 'present', 'geofence'],
      ['Joseph Mwenda', 'present', 'ussd'],
      ['Peter Ochieng', 'present', 'ussd'],
      ['Bernard Kimani', 'absent', 'app'],
    ],
    2: [
      ['Mwangi Kariuki', 'present', 'geofence'],
      ['Otieno Odhiambo', 'present', 'geofence'],
      ['Bernard Kimani', 'present', 'geofence'],
      ['Joseph Mwenda', 'present', 'ussd'],
      ['Peter Ochieng', 'present', 'ussd'],
      ['Kevin Mutiso', 'present', 'geofence'],
    ],
    3: [
      ['Mwangi Kariuki', 'present', 'geofence'],
      ['Otieno Odhiambo', 'present', 'geofence'],
      ['Joseph Mwenda', 'present', 'ussd'],
      ['Peter Ochieng', 'present', 'ussd'],
    ],
    4: [
      ['Mwangi Kariuki', 'present', 'geofence'],
      ['Otieno Odhiambo', 'present', 'geofence'],
      ['Kevin Mutiso', 'present', 'geofence'],
      ['Bernard Kimani', 'present', 'geofence'],
      ['Joseph Mwenda', 'present', 'ussd'],
    ],
    5: [
      ['Mwangi Kariuki', 'present', 'geofence'],
      ['Otieno Odhiambo', 'present', 'geofence'],
      ['Joseph Mwenda', 'present', 'ussd'],
      ['Peter Ochieng', 'present', 'ussd'],
      ['Kevin Mutiso', 'present', 'geofence'],
    ],
    7: [
      ['Mwangi Kariuki', 'present', 'geofence'],
      ['Otieno Odhiambo', 'present', 'geofence'],
      ['Bernard Kimani', 'present', 'geofence'],
      ['Joseph Mwenda', 'present', 'ussd'],
      ['Peter Ochieng', 'present', 'ussd'],
      ['Kevin Mutiso', 'present', 'geofence'],
    ],
  }
  const rates: Record<string, number> = Object.fromEntries(workerDefs.map(w => [w[0], w[3]]))
  for (const [dayStr, entries] of Object.entries(attendancePlan)) {
    const day = Number(dayStr)
    for (const [name, status, method] of entries) {
      await db.attendance.create({
        data: {
          workerId: workers[name],
          projectId: project.id,
          date: isoDate(day),
          checkIn: status === 'absent' ? null : daysAgo(day, 7, 45),
          checkOut: status === 'absent' ? null : daysAgo(day, 17, 15),
          status,
          method,
          wage: status === 'present' ? rates[name] : status === 'half_day' ? rates[name] * 0.5 : 0,
        },
      })
    }
  }

  // ---------- Materials (GLOBAL catalog — shared across projects) ----------
  const materialDefs = [
    ['Cement (32.5N)', 'bag', 780],
    ['Ballast', 'tonne', 2800],
    ['Sand', 'tonne', 1800],
    ['Machine cut stones 9"', 'piece', 58],
    ['Steel bar Y10 (12m)', 'piece', 980],
    ['Binding wire', 'roll', 850],
    ['Timber 2x4 (12ft)', 'piece', 380],
    ['Masonry nails', 'kg', 260],
    ['DPC membrane', 'roll', 4200],
    ['Concrete mix wood shuttering', 'piece', 150],
  ]
  const materials: Record<string, { id: string; unitPrice: number }> = {}
  for (const [name, unit, unitPrice] of materialDefs) {
    const m = await db.material.create({ data: { name, unit, unitPrice } })
    materials[name] = { id: m.id, unitPrice }
  }

  // ---------- Deliveries ----------
  const deliveryDefs: Array<[string, number, number, string, number, string, string?]> = [
    // [material, qty, unitCost, supplier, daysAgo, source, transcript]
    ['Cement (32.5N)', 120, 760, 'Karioke Hardware', 40, 'manual'],
    ['Sand', 30, 1750, 'Mwangaza Suppliers', 39, 'manual'],
    ['Ballast', 20, 2700, 'Mwangaza Suppliers', 39, 'manual'],
    ['Machine cut stones 9"', 4500, 55, 'Ndarugu Quarry', 38, 'manual'],
    ['Cement (32.5N)', 100, 775, 'Karioke Hardware', 24, 'voice', 'Nimepokea mia moja ya cement kutoka Karioke Hardware'],
    ['Steel bar Y10 (12m)', 90, 960, 'Devki Steel', 20, 'manual'],
    ['Binding wire', 12, 840, 'Devki Steel', 20, 'manual'],
    ['Timber 2x4 (12ft)', 120, 370, 'Timsales Yard', 12, 'manual'],
    ['Cement (32.5N)', 80, 790, 'Karioke Hardware', 6, 'voice', 'Amepata bags themanini za cement, Karioke tena'],
    ['Machine cut stones 9"', 2000, 56, 'Ndarugu Quarry', 5, 'manual'],
    ['Masonry nails', 25, 250, 'Karioke Hardware', 5, 'manual'],
    ['DPC membrane', 8, 4100, 'Kingsway Builders', 3, 'manual'],
  ]
  for (const [name, qty, unitCost, supplier, ago, source, transcript] of deliveryDefs) {
    await db.delivery.create({
      data: {
        projectId: project.id,
        materialId: materials[name].id,
        quantity: qty,
        unitCost: unitCost,
        totalCost: qty * unitCost,
        supplier,
        date: daysAgo(ago, 11),
        source,
        rawTranscript: transcript,
      },
    })
  }

  // ---------- Consumption ----------
  const consumptionDefs: Array<[string, number, number, string, string]> = [
    ['Cement (32.5N)', 95, 40, 'Site Prep & Foundation', 'Foundation blinding, walls & floor bed'],
    ['Sand', 22, 40, 'Site Prep & Foundation', 'Mortar for foundation walls'],
    ['Ballast', 16, 40, 'Site Prep & Foundation', 'Concrete for footings'],
    ['Machine cut stones 9"', 4300, 38, 'Site Prep & Foundation', 'Foundation walling'],
    ['Cement (32.5N)', 48, 6, 'Walling', 'Mortar for wall courses 1-8'],
    ['Sand', 9, 6, 'Walling', 'Mortar for wall courses'],
    ['Machine cut stones 9"', 1400, 3, 'Walling', 'Wall courses 9-12'],
    ['Cement (32.5N)', 22, 2, 'Walling', 'Lintel casting'],
    ['Binding wire', 4, 20, 'Walling', 'Column starter bars'],
    ['Steel bar Y10 (12m)', 34, 18, 'Walling', 'Column & ring beam starters'],
  ]
  for (const [name, qty, ago, phaseName, note] of consumptionDefs) {
    await db.consumption.create({
      data: {
        projectId: project.id,
        materialId: materials[name].id,
        quantity: qty,
        phaseName,
        date: daysAgo(ago, 16),
        note,
      },
    })
  }

  // ---------- Transactions ----------
  const txDefs: Array<[string, number, string, string, string, number]> = [
    ['material', 91200, 'mpesa', 'QGH7X2LM90', 'Cement 120 bags — Karioke Hardware', 40],
    ['material', 52500, 'mpesa', 'QGH8K1PP21', 'Sand 30t — Mwangaza Suppliers', 39],
    ['material', 54000, 'mpesa', 'QGH9M3QR45', 'Ballast 20t — Mwangaza Suppliers', 39],
    ['material', 247500, 'bank', 'FT2291KQ0', 'Machine cut stones 4500pcs — Ndarugu', 38],
    ['wage', 8900, 'mpesa', 'SB01AAA110', 'Week 7 wages — 7 fundis', 34],
    ['wage', 8900, 'mpesa', 'SB01BBB220', 'Week 8 wages — 7 fundis', 27],
    ['material', 77500, 'mpesa', 'QGK2T5VX78', 'Cement 100 bags — Karioke Hardware', 24],
    ['material', 86400, 'bank', 'FT2311LM02', 'Y10 steel 90pcs — Devki Steel', 20],
    ['wage', 8600, 'mpesa', 'SB01CCC330', 'Week 9 wages', 20],
    ['transport', 12000, 'mpesa', 'QGL4W8YZ11', 'Tipper hire — stones haulage', 5],
    ['material', 63200, 'mpesa', 'QGM5X1AB34', 'Cement 80 bags — Karioke Hardware', 6],
    ['wage', 8400, 'mpesa', 'SB01DDD440', 'Week 10 wages', 6],
    ['wage', 8100, 'mpesa', 'SB01EEE550', 'Week 11 wages', 0],
  ]
  for (const [type, amount, method, reference, note, ago] of txDefs) {
    await db.transaction.create({
      data: { projectId: project.id, type, amount, method, reference, note, date: daysAgo(ago, 13) },
    })
  }

  // ---------- Site photos ----------
  const photoDefs: Array<[string, string, string | null, number | null, number]> = [
    ['/photos/foundation-done.png', 'Foundation walls complete — rear elevation', null, null, 36],
    ['/photos/walling-progress.png', 'Walling courses 9-12 in progress', 'Walling', 60, 4],
    ['/photos/cement-delivery.png', 'Cement delivery — 80 bags, Karioke Hardware', null, null, 6],
    ['/photos/workers-onsite.png', 'Crew on site — morning session', null, null, 1],
    ['/photos/site-aerial.png', 'Aerial view — ring beam prep', null, null, 0],
  ]
  for (const [url, caption, phaseName, pct, ago] of photoDefs) {
    await db.sitePhoto.create({
      data: {
        projectId: project.id,
        phaseId: phaseName ? phases[phaseName].id : null,
        url,
        caption,
        analysis: null,
        progressPct: pct,
        createdAt: daysAgo(ago, 15),
      },
    })
  }

  // ---------- Alerts ----------
  const alertDefs: Array<[string, string, string, string, boolean, number]> = [
    ['budget', 'warning', 'Cement unit price up 4% across deliveries', 'Cement has risen from KSh 760 to KSh 790/bag over the last 6 weeks (Karioke Hardware). At the current walling burn rate (~7.7 bags per 10% progress), the roofing phase will need ~220 more bags — locking a bulk price now would save an estimated KSh 15,000.', false, 2],
    ['attendance', 'info', 'Peter Ochieng — half day (USSD check-in)', 'Peter checked in via USSD *384*88# at 07:58 and checked out at 12:40. Half-day wage of KSh 400 auto-calculated.', true, 0],
    ['anomaly', 'critical', 'Possible cement variance on site', 'Delivered-to-date: 300 bags. Consumed per work logs: 165 bags (foundation + walling). Expected usage for completed work: ~198 bags. A variance of ~33 bags (KSh 25,000) is unaccounted for. Recommend a physical stock count.', false, 1],
  ]
  for (const [type, severity, title, message, ack, ago] of alertDefs) {
    await db.alert.create({
      data: { projectId: project.id, type, severity, title, message, acknowledged: ack, createdAt: daysAgo(ago, 18) },
    })
  }

  // ==========================================================================
  // PROJECT 2 — Kiambu Road Duplex (early-stage, active)
  // ==========================================================================
  const p2 = await db.project.create({
    data: {
      name: 'Kiambu Road Duplex',
      client: 'Mwenda Family',
      clientType: 'local',
      location: 'Kiambu Road, Nairobi',
      budget: 8500000,
      startDate: daysAgo(12),
      targetDate: daysAgo(-128),
      status: 'active',
      createdAt: daysAgo(12, 8, 30),
    },
  })

  // Duplex-template phases (22 / 22 / 14 / 16 / 26) — only Phase 1 in progress
  const p2PhaseDefs = [
    { name: 'Site Prep & Foundation', budget: 1870000, status: 'in_progress', progressManual: 35 },
    { name: 'Walling', budget: 1870000, status: 'pending', progressManual: null },
    { name: 'Roofing', budget: 1190000, status: 'pending', progressManual: null },
    { name: 'Plumbing & Electrical', budget: 1360000, status: 'pending', progressManual: null },
    { name: 'Finishing', budget: 2210000, status: 'pending', progressManual: null },
  ]
  const p2Phases: Record<string, { id: string }> = {}
  for (let i = 0; i < p2PhaseDefs.length; i++) {
    const d = p2PhaseDefs[i]
    const phase = await db.phase.create({
      data: {
        projectId: p2.id,
        name: d.name,
        order: i + 1,
        budget: d.budget,
        status: d.status,
        progressManual: d.progressManual,
      },
    })
    p2Phases[d.name] = phase
    if (i === 0) {
      // tasks only under Phase 1
      const p2Tasks: Array<[string, string, number]> = [
        ['Site clearing & setting out', 'done', 100],
        ['Excavation & foundation trenches', 'in_progress', 40],
        ['Blinding layer & setting bases', 'pending', 0],
        ['Foundation walling (stone)', 'pending', 0],
      ]
      for (const [title, status, progress] of p2Tasks) {
        await db.task.create({ data: { phaseId: phase.id, title, status, progress } })
      }
    }
  }

  // 4 fundis
  const p2Workers = [
    ['Joseph Kimani', 'Foreman (Mkuu wa Site)', '0722001100', 1500],
    ['Peter Otieno', 'Fundi wa Mawe (Mason)', '0733445566', 1200],
    ['Brian Mwangi', 'Mtumishi (Labourer)', '0714778899', 800],
    ['Sarah Wanjiru', 'Fundi wa Maji (Plumber)', '0790223344', 1000],
  ]
  const p2WorkerIds: Record<string, string> = {}
  const p2Rates: Record<string, number> = {}
  for (const [name, role, phone, rate] of p2Workers) {
    const w = await db.worker.create({ data: { projectId: p2.id, name, role, phone, dailyRate: rate } })
    p2WorkerIds[name] = w.id
    p2Rates[name] = rate
  }

  // Attendance: last 8 weekdays, mix of present / half_day / absent (most recent 2 unpaid)
  const p2Attendance: Array<Record<string, string>> = [
    { 'Joseph Kimani': 'present', 'Peter Otieno': 'present', 'Brian Mwangi': 'present', 'Sarah Wanjiru': 'absent' },
    { 'Joseph Kimani': 'present', 'Peter Otieno': 'present', 'Brian Mwangi': 'present', 'Sarah Wanjiru': 'present' },
    { 'Joseph Kimani': 'present', 'Peter Otieno': 'present', 'Brian Mwangi': 'half_day', 'Sarah Wanjiru': 'absent' },
    { 'Joseph Kimani': 'present', 'Peter Otieno': 'absent', 'Brian Mwangi': 'present', 'Sarah Wanjiru': 'present' },
    { 'Joseph Kimani': 'present', 'Peter Otieno': 'present', 'Brian Mwangi': 'present', 'Sarah Wanjiru': 'present' },
    { 'Joseph Kimani': 'present', 'Peter Otieno': 'half_day', 'Brian Mwangi': 'present', 'Sarah Wanjiru': 'absent' },
    { 'Joseph Kimani': 'present', 'Peter Otieno': 'present', 'Brian Mwangi': 'present', 'Sarah Wanjiru': 'present' },
    { 'Joseph Kimani': 'present', 'Peter Otieno': 'present', 'Brian Mwangi': 'absent', 'Sarah Wanjiru': 'present' },
  ]
  const p2Methods: Record<string, string> = {
    'Joseph Kimani': 'geofence', 'Peter Otieno': 'geofence', 'Brian Mwangi': 'ussd', 'Sarah Wanjiru': 'app',
  }
  const p2Days = lastWeekdays(8)
  for (let d = 0; d < p2Days.length; d++) {
    const [ago, date] = p2Days[d]
    const plan = p2Attendance[d]
    for (const [name, status] of Object.entries(plan)) {
      await db.attendance.create({
        data: {
          workerId: p2WorkerIds[name],
          projectId: p2.id,
          date,
          checkIn: status === 'absent' ? null : daysAgo(ago, 7, 50),
          checkOut: status === 'absent' ? null : daysAgo(ago, 17, 10),
          status,
          method: p2Methods[name],
          wage: status === 'present' ? p2Rates[name] : status === 'half_day' ? p2Rates[name] * 0.5 : 0,
          paid: d >= 6, // older days paid out, the 2 most recent unpaid
        },
      })
    }
  }

  // 4 deliveries + matching transactions
  const p2Deliveries: Array<[string, number, number, string, number, string, string]> = [
    // [material, qty, unitCost, supplier, daysAgo, txReference, txNote]
    ['Cement (32.5N)', 100, 780, 'Kiambu Hardware Depot', 10, 'QKR1C100KT', 'Cement 100 bags — Kiambu Hardware Depot'],
    ['Ballast', 7, 2800, 'Mwangaza Suppliers', 9, 'QKR2B007MS', 'Ballast 7t — Mwangaza Suppliers'],
    ['Sand', 10, 1800, 'Mwangaza Suppliers', 9, 'QKR3S010MS', 'Sand 10t — Mwangaza Suppliers'],
    ['Steel bar Y10 (12m)', 40, 960, 'Devki Steel', 5, 'QKR4R040DS', 'Y10 rebar 40pcs — Devki Steel'],
  ]
  for (const [name, qty, unitCost, supplier, ago, reference, note] of p2Deliveries) {
    await db.delivery.create({
      data: {
        projectId: p2.id,
        materialId: materials[name].id,
        quantity: qty,
        unitCost,
        totalCost: qty * unitCost,
        supplier,
        date: daysAgo(ago, 11),
        source: 'manual',
      },
    })
    await db.transaction.create({
      data: {
        projectId: p2.id,
        type: 'material',
        amount: qty * unitCost,
        method: 'mpesa',
        reference,
        note,
        date: daysAgo(ago, 13),
      },
    })
  }

  // 1 consumption
  await db.consumption.create({
    data: {
      projectId: p2.id,
      materialId: materials['Cement (32.5N)'].id,
      quantity: 38,
      phaseName: 'Site Prep & Foundation',
      date: daysAgo(2, 16),
      note: 'Foundation blinding & footings concrete',
    },
  })

  // 2 site photos
  await db.sitePhoto.create({
    data: {
      projectId: p2.id,
      phaseId: p2Phases['Site Prep & Foundation'].id,
      url: '/photos/foundation-done.png',
      caption: 'Duplex foundation trenches & blinding — Kiambu Road',
      analysis: null,
      progressPct: 35,
      createdAt: daysAgo(3, 15),
    },
  })
  await db.sitePhoto.create({
    data: {
      projectId: p2.id,
      phaseId: null,
      url: '/photos/cement-delivery.png',
      caption: 'Cement delivery — 100 bags for foundation pour',
      analysis: null,
      progressPct: null,
      createdAt: daysAgo(10, 12),
    },
  })

  // 1 unacked budget alert
  await db.alert.create({
    data: {
      projectId: p2.id,
      type: 'budget',
      severity: 'warning',
      title: 'Foundation concrete pour quoted 12% above plan',
      message: 'Foundation concrete pour quoted 12% above plan — review supplier quotes from the three ready-mix vendors before Friday\'s pour. Delaying approval risks the 2-week foundation schedule on the duplex.',
      acknowledged: false,
      createdAt: daysAgo(1, 10),
    },
  })

  // ==========================================================================
  // PROJECT 3 — Diani Beach Bungalow Renovation (completed)
  // ==========================================================================
  const p3 = await db.project.create({
    data: {
      name: 'Diani Beach Bungalow Renovation',
      client: 'Aisha & Omar (Diaspora · London)',
      clientType: 'diaspora',
      location: 'Diani, Kwale County',
      budget: 2800000,
      startDate: daysAgo(240),
      targetDate: daysAgo(60),
      status: 'completed',
      createdAt: daysAgo(6, 8, 15), // added to MjengoOS retroactively for record-keeping
    },
  })

  // Bungalow-template phases (25 / 20 / 15 / 15 / 25) — all done
  const p3PhaseDefs = [
    { name: 'Site Prep & Foundation', budget: 700000 },
    { name: 'Walling', budget: 560000 },
    { name: 'Roofing', budget: 420000 },
    { name: 'Plumbing & Electrical', budget: 420000 },
    { name: 'Finishing', budget: 700000 },
  ]
  for (let i = 0; i < p3PhaseDefs.length; i++) {
    await db.phase.create({
      data: {
        projectId: p3.id,
        name: p3PhaseDefs[i].name,
        order: i + 1,
        budget: p3PhaseDefs[i].budget,
        status: 'done',
        progressManual: 100,
      },
    })
  }

  // 3 fundis (historical crew)
  const p3Workers = [
    ['Mwakideu Chengo', 'Fundi wa Mawe (Mason)', '0721556677', 1300],
    ['Athman Salim', 'Mtumishi (Labourer)', '0733889900', 700],
    ['Neema Mwakembe', 'Fundi wa Malazi (Finisher)', '0791772200', 1100],
  ]
  const p3WorkerIds: Record<string, string> = {}
  const p3Rates: Record<string, number> = {}
  for (const [name, role, phone, rate] of p3Workers) {
    const w = await db.worker.create({ data: { projectId: p3.id, name, role, phone, dailyRate: rate } })
    p3WorkerIds[name] = w.id
    p3Rates[name] = rate
  }

  // Attendance near the end of the build — all paid
  const p3Days = lastWeekdays(5).map(([ago]) => ago + 63) // ~65-70 days ago
  const p3Statuses = ['present', 'present', 'present', 'half_day', 'present']
  let p3Cursor = 0
  for (const ago of p3Days) {
    for (const [name] of p3Workers) {
      const status = p3Statuses[p3Cursor % p3Statuses.length]
      p3Cursor++
      await db.attendance.create({
        data: {
          workerId: p3WorkerIds[name],
          projectId: p3.id,
          date: isoDate(ago),
          checkIn: status === 'absent' ? null : daysAgo(ago, 8, 5),
          checkOut: status === 'absent' ? null : daysAgo(ago, 17, 0),
          status,
          method: 'geofence',
          wage: status === 'present' ? p3Rates[name] : status === 'half_day' ? p3Rates[name] * 0.5 : 0,
          paid: true,
        },
      })
    }
  }

  // Transactions ≈ 95% of budget (2,660,000 of 2,800,000)
  const p3TxDefs: Array<[string, number, string, string, string, number]> = [
    ['material', 1540000, 'bank', 'FT8821DK01', 'Materials — full renovation (cement, mabati, finishes)', 230],
    ['transport', 120000, 'mpesa', 'QDN7Y2PL44', 'Lorry hire — materials haulage to Diani', 100],
    ['other', 280000, 'bank', 'FT8844DK09', 'Paint, fittings & fixtures', 80],
    ['wage', 720000, 'mpesa', 'SB99ZZZ990', 'Crew wages — 16 weeks (3 fundis)', 70],
  ]
  for (const [type, amount, method, reference, note, ago] of p3TxDefs) {
    await db.transaction.create({
      data: { projectId: p3.id, type, amount, method, reference, note, date: daysAgo(ago, 13) },
    })
  }

  // 3 photos
  const p3Photos: Array<[string, string, number]> = [
    ['/photos/walling-progress.png', 'Repainted & repaired walls — final coat', 85],
    ['/photos/workers-onsite.png', 'Diani crew — final walkthrough with client rep', 62],
    ['/photos/site-aerial.png', 'Completed bungalow — aerial at handover', 60],
  ]
  for (const [url, caption, ago] of p3Photos) {
    await db.sitePhoto.create({
      data: {
        projectId: p3.id,
        phaseId: null,
        url,
        caption,
        analysis: null,
        progressPct: 100,
        createdAt: daysAgo(ago, 14),
      },
    })
  }

  // 1 acknowledged (info) alert — zero unacked
  await db.alert.create({
    data: {
      projectId: p3.id,
      type: 'info',
      severity: 'info',
      title: 'Handover complete — snag list closed',
      message: 'Final snag list items closed and keys handed to Aisha & Omar\'s local representative. 5% retention released to the contractor.',
      acknowledged: true,
      createdAt: daysAgo(58, 16),
    },
  })

  // 2 recaps
  await db.recap.create({
    data: {
      projectId: p3.id,
      day: 172,
      content: '📍 Day 172 — Diani Renovation: Finishing phase at 80%. Crew of 3 on site (Mwakideu, Athman, Neema). Final paint batch delivered: 40L premium marine coat. 💰 Spend: KSh 2.38M of KSh 2.8M. 📸 Photo evidence on file ✅ — MjengoOS',
      createdAt: daysAgo(68, 18),
    },
  })
  await db.recap.create({
    data: {
      projectId: p3.id,
      day: 180,
      content: '📍 Day 180 — FINAL DAY: Diani Renovation complete 🎉 All 5 phases at 100%, final inspection passed, keys handed over to your representative. 💰 Final spend: KSh 2.66M (95% of budget). Asanta sana for building with MjengoOS — MjengoOS',
      createdAt: daysAgo(60, 18),
    },
  })

  console.log('Seed complete:', {
    projects: [project.id, p2.id, p3.id],
    counts: {
      phases: await db.phase.count(),
      tasks: await db.task.count(),
      workers: await db.worker.count(),
      attendance: await db.attendance.count(),
      materials: await db.material.count(),
      deliveries: await db.delivery.count(),
      consumptions: await db.consumption.count(),
      transactions: await db.transaction.count(),
      photos: await db.sitePhoto.count(),
      alerts: await db.alert.count(),
      recaps: await db.recap.count(),
    },
  })
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
