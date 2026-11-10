// Chế độ "Chạy trạm": trạng thái hành trình của từng team (teams.tram, JSON chỉ server đọc),
// bắt đầu trận (thời kỳ, rải key, mảnh ghép). Các luật gợi ý / cứu / câu hỏi / ghép thêm ở các task sau.

import { REGIONS, RULES } from './rules.js'

const TRIES = 200

// Rải n key cho tỉnh xuất phát `start`: ứng viên = eligible trừ start và tỉnh kề start.
// Thử ngẫu nhiên tối đa 200 lần: mỗi miền ≥ 1 key và không hai key kề nhau; không được → 200 lần chỉ đòi mỗi miền ≥ 1;
// vẫn không được → n ứng viên bất kỳ. `random` truyền vào (ctx.random) để test cố định được.
export function placeKeys(start, n, eligible, { provinces, adjacency, random }) {
  const near = adjacency.get(start)
  const pool = eligible.filter(id => id !== start && !near.has(id))
  const pick = () => {
    const a = [...pool]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a.slice(0, n)
  }
  const everyRegion = keys => REGIONS.every(r => keys.some(k => provinces.get(k).region === r))
  const noneAdjacent = keys => keys.every(a => keys.every(b => a === b || !adjacency.get(a).has(b)))
  for (const strict of [true, false]) {
    for (let i = 0; i < TRIES; i++) {
      const keys = pick()
      if (keys.length === n && everyRegion(keys) && (!strict || noneAdjacent(keys))) return keys
    }
  }
  return pick()
}

export function createTram(ctx) {
  const { db, q, now, random, json, provinces, adjacency, roomId, log, tram: content } = ctx

  const state = t => json(t.tram)
  const save = (teamId, st) => db.prepare('UPDATE teams SET tram = ? WHERE id = ?').run(JSON.stringify(st), teamId)

  // Bắt đầu trận (gọi trong transaction): mỗi team một thời kỳ ngẫu nhiên, n key và hoán vị mảnh ghép
  function setupTeams(pairs) {
    const n = q.room.get(roomId).key_count
    const periodIds = [...content.periods.keys()]
    const eligible = [...content.hints.keys()]
    for (const [teamId, start] of pairs) {
      const keys = placeKeys(start, n, eligible, { provinces, adjacency, random })
      const perm = [...Array(n).keys()]
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[perm[i], perm[j]] = [perm[j], perm[i]]
      }
      save(teamId, {
        period: periodIds[Math.floor(random() * periodIds.length)],
        need: n,
        keys: keys.map((province, i) => ({ province, piece: perm[i], hint: 0, hintAt: null, found: false, foundAt: null })),
        hints: [], correct: 0, rescued: false, star: 'ready', stage: 'map',
        openedAt: null, free: 0,
        special: { done: 0, seen: [], pending: null, lockedUntil: null },
        puzzle: { lockedUntil: null, tries: 0 },
        finishedAt: null, finishBonus: 0,
      })
    }
  }

  // Tạm dừng xong: dời các mốc thời gian trong teams.tram thêm gapMs (Task 7 thêm các bộ đếm giờ)
  function shift(gapMs, pausedAt) {
    // chưa có mốc giờ nào cần dời
  }

  // Khoảng cách BFS (số bước) từ `from` tới mọi tỉnh
  function distances(from) {
    const dist = new Map([[from, 0]])
    const queue = [from]
    for (let i = 0; i < queue.length; i++) {
      for (const n of adjacency.get(queue[i]) ?? []) {
        if (!dist.has(n)) { dist.set(n, dist.get(queue[i]) + 1); queue.push(n) }
      }
    }
    return dist
  }

  // Ghi một gợi ý cho key `index` ở mức `level` (tỉnh không có mức 2 → dùng mức 1). Trả về { level, text } hoặc null
  function giveHint(st, index, level) {
    const key = st.keys[index]
    const list = content.hints.get(key.province) ?? []
    const h = list.find(x => x.level === level) ?? list.find(x => x.level === 1)
    if (!h) return null
    key.hint = level
    key.hintAt = now()
    st.hints.push({ key: index, level, text: h.text, at: key.hintAt })
    return { level, text: h.text }
  }

  // Gợi ý theo mốc 3 tỉnh đúng: key chưa nhặt chưa gợi ý gần nhất (BFS, bằng nhau → random);
  // hết thì key đã gợi ý mức 1 sớm nhất → mức 2
  function nextHint(st, from) {
    const open = st.keys.map((k, i) => ({ k, i })).filter(x => !x.k.found)
    const fresh = open.filter(x => x.k.hint === 0)
    if (fresh.length) {
      const dist = distances(from)
      const d = x => dist.get(x.k.province) ?? Infinity
      const best = Math.min(...fresh.map(d))
      const ties = fresh.filter(x => d(x) === best)
      return giveHint(st, ties[Math.floor(random() * ties.length)].i, 1)
    }
    const second = open.filter(x => x.k.hint === 1).sort((a, b) => a.k.hintAt - b.k.hintAt)[0]
    return second ? giveHint(st, second.i, 2) : null
  }

  // Team vừa được cắm tem ở `provinceId` (gọi trong transaction): nhặt key, gợi ý mỗi 3 tỉnh đúng, mở map khi đủ key
  function onCorrect(t, provinceId, by = null) {
    const st = json(db.prepare('SELECT tram FROM teams WHERE id = ?').get(t.id).tram)
    if (!st || st.stage !== 'map') return {}
    const out = {}
    const idx = st.keys.findIndex(k => k.province === provinceId && !k.found)
    if (idx >= 0) {
      const k = st.keys[idx]
      k.found = true
      k.foundAt = now()
      const piece = content.periods.get(st.period).puzzle.splits[st.need][k.piece]
      out.key = { piece }
      log(t.id, 'tram-key', provinceId, { n: st.keys.filter(x => x.found).length, of: st.need }, by)
    }
    st.correct += 1
    if (st.correct % RULES.tram.hintEvery === 0) {
      const h = nextHint(st, provinceId)
      if (h) {
        out.hint = h
        log(t.id, 'tram-hint', null, { level: h.level }, by)
      }
    }
    if (st.keys.every(k => k.found)) {
      const seen = new Set(q.visits.all(t.id).map(r => r.province_id))
      let free = 0
      for (const p of provinces.values()) if (!seen.has(p.id)) free += p.points
      st.stage = 'special'
      st.openedAt = now()
      st.free = free
      if (free) db.prepare('UPDATE teams SET bonus_points = bonus_points + ? WHERE id = ?').run(free, t.id)
      out.opened = { free }
      log(t.id, 'tram-open', null, { free }, by)
    }
    save(t.id, st)
    return out
  }

  // Luật cứu: tới nửa thời lượng, mỗi team chưa cứu nhận gợi ý mức 1 cho mọi key chưa nhặt chưa có gợi ý.
  // Gọi từ state() — ends_at đã dời khi tiếp tục nên mốc tự đúng sau tạm dừng. Rẻ khi chưa tới mốc / mọi team đã cứu
  function tick() {
    const room = q.room.get(roomId)
    if (room.status !== 'running' || !room.ends_at || now() < room.ends_at - room.duration_min * 30_000) return
    for (const row of db.prepare('SELECT id, tram FROM teams WHERE room_id = ? AND tram IS NOT NULL').all(roomId)) {
      const st = json(row.tram)
      if (st.rescued) continue
      st.keys.forEach((k, i) => { if (!k.found && k.hint === 0) giveHint(st, i, 1) })
      st.rescued = true
      save(row.id, st)
      log(row.id, 'tram-rescue')
    }
  }

  return { setupTeams, state, save, shift, onCorrect, tick, placeKeys: (start, n, eligible) => placeKeys(start, n, eligible, { provinces, adjacency, random }) }
}
