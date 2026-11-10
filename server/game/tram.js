// Chế độ "Chạy trạm": trạng thái hành trình của từng team (teams.tram, JSON chỉ server đọc),
// bắt đầu trận (thời kỳ, rải key, mảnh ghép). Các luật gợi ý / cứu / câu hỏi / ghép thêm ở các task sau.

import { REGIONS } from './rules.js'

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
  const { db, q, random, json, provinces, adjacency, roomId, tram: content } = ctx

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

  return { setupTeams, state, save, shift, placeKeys: (start, n, eligible) => placeKeys(start, n, eligible, { provinces, adjacency, random }) }
}
