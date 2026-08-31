/**
 * MjengoOS evidence seed-extras — zones, photo comments, notifications, audit history.
 * Standalone: own PrismaClient, safe to run after prisma/seed.ts and the other
 * seed-extras modules. Wipes ONLY PhotoComment / SiteZone / Notification and
 * resets SitePhoto.zoneId — never touches projects, money or trust data.
 *
 * Run: bun prisma/seed-extras/evidence.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function daysAgo(n: number, hour = 9, minute = 0) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

async function main() {
  console.log('— evidence seed-extras: zones · comments · notifications · audit trail —')

  // Wipe (evidence-owned models only)
  await db.photoComment.deleteMany()
  await db.siteZone.deleteMany()
  await db.notification.deleteMany()
  await db.sitePhoto.updateMany({ data: { zoneId: null } })

  const projects = await db.project.findMany({ orderBy: { createdAt: 'asc' } })
  if (projects.length < 3) throw new Error('Expected 3 seeded projects — run `bun prisma/seed.ts` first')
  const [p1, p2, p3] = projects

  const photos = async (projectId: string) =>
    db.sitePhoto.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })
  const byUrl = (rows: Array<{ id: string; url: string }>, url: string) => rows.find((p) => p.url === url)

  // ==========================================================================
  // P1 — Nyumba Yangu — 3BR Bungalow (flagship demo)
  // ==========================================================================
  const p1Photos = await photos(p1.id)

  const p1ZoneDefs: Array<[string, number, number, number, number]> = [
    ['Foundation & slab', 8, 8, 40, 30],
    ['Living room', 52, 10, 30, 26],
    ['Kitchen', 52, 42, 26, 24],
    ['Master bedroom', 24, 44, 34, 26],
    ['Bathrooms', 62, 70, 20, 18],
  ]
  const p1Zones: Record<string, string> = {}
  for (const [name, x, y, w, h] of p1ZoneDefs) {
    const z = await db.siteZone.create({ data: { projectId: p1.id, name, x, y, w, h } })
    p1Zones[name] = z.id
  }

  // Tag photos to zones sensibly (site-aerial stays untagged)
  const p1Tags: Array<[string, string]> = [
    ['/photos/foundation-done.png', 'Foundation & slab'],
    ['/photos/walling-progress.png', 'Living room'],
    ['/photos/workers-onsite.png', 'Master bedroom'],
    ['/photos/cement-delivery.png', 'Foundation & slab'],
  ]
  for (const [url, zone] of p1Tags) {
    const photo = byUrl(p1Photos, url)
    if (photo) await db.sitePhoto.update({ where: { id: photo.id }, data: { zoneId: p1Zones[zone] } })
  }

  // Comments — client question thread on the walling photo + resolved one on foundation
  const wallingPhoto = byUrl(p1Photos, '/photos/walling-progress.png')
  const foundationPhoto = byUrl(p1Photos, '/photos/foundation-done.png')
  if (wallingPhoto) {
    await db.photoComment.create({
      data: {
        photoId: wallingPhoto.id, projectId: p1.id,
        author: 'Amina (Client)', role: 'client',
        message: 'Why is the window frame placed here?',
        resolved: false, createdAt: daysAgo(2, 18),
      },
    })
    await db.photoComment.create({
      data: {
        photoId: wallingPhoto.id, projectId: p1.id,
        author: 'Site Manager', role: 'contractor',
        message: 'Following the revised plan — variation approved 12 Aug',
        resolved: false, createdAt: daysAgo(2, 19),
      },
    })
  }
  if (foundationPhoto) {
    await db.photoComment.create({
      data: {
        photoId: foundationPhoto.id, projectId: p1.id,
        author: 'Amina (Client)', role: 'client',
        message: 'Foundation backfill looks solid — thank you for the photo evidence.',
        resolved: true, createdAt: daysAgo(30, 17),
      },
    })
  }

  // Notifications (matching money/recap flow titles)
  await db.notification.create({
    data: {
      projectId: p1.id, kind: 'recap', title: '6 PM recap sent to client',
      body: 'Day 46 walling update — courses 9-12 at 62%, crew of 7, spend KSh 2.79M of 4.5M.',
      channel: 'whatsapp', recipient: 'Amina (Client)', read: true, createdAt: daysAgo(0, 18),
    },
  })
  await db.notification.create({
    data: {
      projectId: p1.id, kind: 'comment', title: 'Client question on a site photo',
      body: 'Why is the window frame placed here?',
      channel: 'in_app', recipient: 'Site team', read: false, createdAt: daysAgo(2, 18),
    },
  })
  await db.notification.create({
    data: {
      projectId: p1.id, kind: 'milestone', title: 'Milestone release requested — awaiting client approval',
      body: 'Site Manager requested release of the Walling milestone (KSh 1,200,000). Review the attached proof-of-work photos.',
      channel: 'in_app', recipient: 'Amina (Client)', read: false, createdAt: daysAgo(1, 12),
    },
  })

  // Audit history — 8 realistic backdated entries over the last 3 weeks
  const p1Audit: Array<[string, string, string, string, number]> = [
    ['delivery', 'Site Manager', 'contractor', 'Logged delivery: 80× Cement (32.5N) from Karioke Hardware', 19],
    ['photo', 'MjengoOS AI', 'ai', 'Photo evidence verified — walling progress 60% matches work logs', 18],
    ['wage', 'Site Manager', 'contractor', 'Paid wages — KSh 8,400 (week 10, 7 fundis)', 16],
    ['variation', 'Amina (Client)', 'client', 'Variation approved by client — window relocation, +KSh 45,000', 13],
    ['milestone', 'Site Manager', 'contractor', 'Milestone released — Foundation & slab KSh 900,000', 10],
    ['share', 'Site Manager', 'contractor', 'Share link regenerated for client preview', 7],
    ['photo', 'Site Manager', 'contractor', 'Site photo evidence attached (60% phase progress)', 4],
    ['comment', 'Amina (Client)', 'client', 'Photo comment by Amina (Client)', 2],
  ]
  for (const [kind, actor, role, summary, ago] of p1Audit) {
    await db.auditEvent.create({
      data: {
        projectId: p1.id, kind, actor, role, summary,
        meta: JSON.stringify({ seeded: true }),
        createdAt: daysAgo(ago, 11),
      },
    })
  }

  // ==========================================================================
  // P2 — Kiambu Road Duplex (early-stage)
  // ==========================================================================
  const p2Photos = await photos(p2.id)
  await db.siteZone.create({
    data: { projectId: p2.id, name: 'Site office', x: 68, y: 62, w: 26, h: 26 },
  })
  const p2Foundation = await db.siteZone.create({
    data: { projectId: p2.id, name: 'Foundation zone', x: 14, y: 14, w: 46, h: 40 },
  })
  const p2FoundationPhoto = byUrl(p2Photos, '/photos/foundation-done.png')
  if (p2FoundationPhoto) {
    await db.sitePhoto.update({ where: { id: p2FoundationPhoto.id }, data: { zoneId: p2Foundation.id } })
  }
  await db.photoComment.create({
    data: {
      photoId: (p2FoundationPhoto ?? p2Photos[0]).id, projectId: p2.id,
      author: 'Mwenda Family', role: 'client',
      message: 'Trenches look deep enough — when is the foundation pour scheduled?',
      resolved: false, createdAt: daysAgo(2, 10),
    },
  })

  // ==========================================================================
  // P3 — Diani Beach Bungalow Renovation (completed)
  // ==========================================================================
  const p3Photos = await photos(p3.id)
  const p3ZoneDefs: Array<[string, number, number, number, number]> = [
    ['Living area', 10, 10, 40, 35],
    ['Bedrooms', 55, 15, 35, 35],
    ['Outdoor patio', 25, 60, 45, 30],
  ]
  const p3Zones: Record<string, string> = {}
  for (const [name, x, y, w, h] of p3ZoneDefs) {
    const z = await db.siteZone.create({ data: { projectId: p3.id, name, x, y, w, h } })
    p3Zones[name] = z.id
  }
  const p3Walling = byUrl(p3Photos, '/photos/walling-progress.png')
  const p3Workers = byUrl(p3Photos, '/photos/workers-onsite.png')
  if (p3Walling) await db.sitePhoto.update({ where: { id: p3Walling.id }, data: { zoneId: p3Zones['Living area'] } })
  if (p3Workers) await db.sitePhoto.update({ where: { id: p3Workers.id }, data: { zoneId: p3Zones['Bedrooms'] } })
  if (p3Walling) {
    await db.photoComment.create({
      data: {
        photoId: p3Walling.id, projectId: p3.id,
        author: 'Aisha (Client)', role: 'client',
        message: 'Please use the marine-grade paint we agreed for the veranda walls.',
        resolved: true, createdAt: daysAgo(85, 15),
      },
    })
  }

  console.log('Evidence seed complete:', {
    P1: { zones: 5, comments: 3, notifications: 3, auditEvents: 8 },
    P2: { zones: 2, comments: 1 },
    P3: { zones: 3, comments: 1 },
  })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
