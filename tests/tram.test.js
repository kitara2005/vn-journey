import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTramContent } from '../server/game/tram-content.js'
import { tramFixture, tramFixtureWith } from './fixtures/tram-content.js'
import { setupGame, createCore, memoryDb, placeTeam, correctAnswer, wrongAnswer, seededRandom } from './helpers.js'
import { placeKeys } from '../server/game/tram.js'
import { GameError } from '../server/game/rules.js'

test('loadTramContent chỉ lấy mục reviewed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tram-'))
  writeFileSync(join(dir, 'periods.json'), JSON.stringify({ periods: [{ id: 'x', reviewed: true }, { id: 'y', reviewed: false }] }))
  writeFileSync(join(dir, 'key-hints.json'), JSON.stringify({ hints: {
    A: [{ level: 1, text: 't', reviewed: true }, { level: 2, text: 'u', reviewed: false }],
    B: [{ level: 1, text: 't', reviewed: false }],
  } }))
  const c = loadTramContent(dir)
  assert.equal(c.periods.size, 1)
  assert.ok(c.periods.has('x'))
  assert.ok(c.hints.has('A') && !c.hints.has('B'))
  assert.equal(c.hints.get('A').length, 1)
})

test('loadTramContent đọc data/ thật (file rỗng hợp lệ)', () => {
  const c = loadTramContent()
  assert.ok(c.periods instanceof Map && c.hints instanceof Map)
})

test('fixture: 2 thời kỳ, hint cho đủ 34 tỉnh, splits 3-7 nối lại đúng text', () => {
  assert.equal(tramFixture.periods.size, 2)
  assert.equal(tramFixture.hints.size, 34)
  for (const p of tramFixture.periods.values()) {
    assert.equal(p.questions.length, 6)
    for (let n = 3; n <= 7; n++) {
      assert.equal(p.puzzle.splits[n].length, n)
      assert.equal(p.puzzle.splits[n].join(' '), p.puzzle.text)
    }
  }
  assert.equal(tramFixtureWith({ hintProvinces: ['ha-noi'] }).hints.size, 1)
})

test('createGame truyền tram xuống ctx (mặc định fixture trong test helper)', () => {
  const { core } = setupGame({ start: false })
  assert.equal(core.tram, tramFixture)
})

test('tạo phòng tram: mặc định 5 key, tắt cược/chủ đề, có team như phòng team', () => {
  const db = memoryDb()
  const core = createCore(db)
  const { roomId } = core.createRoom({ name: 'T', mode: 'tram', teamCount: 3 })
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId)
  assert.equal(row.mode, 'tram')
  assert.equal(row.key_count, 5)
  assert.equal(row.bet_choice, 0)
  assert.equal(row.topic_choice, 0)
  assert.equal(row.quiz_count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams WHERE room_id = ?').get(roomId).n, 3)
})

test('tạo phòng tram: từ chối tham số và nội dung không đủ', () => {
  const core = createCore()
  const bad = (opts, code) => assert.throws(() => core.createRoom({ name: 'T', mode: 'tram', teamCount: 3, ...opts }),
    e => e instanceof GameError && e.code === code)
  bad({ keyCount: 2 }, 'bad-room')
  bad({ keyCount: 8 }, 'bad-room')
  bad({ durationMin: 20 }, 'bad-room')
  const ids = [...tramFixture.hints.keys()]
  const few = createCore(undefined, undefined, { tramContent: tramFixtureWith({ hintProvinces: ids.slice(0, 7) }) })
  assert.throws(() => few.createRoom({ name: 'T', mode: 'tram', teamCount: 3, keyCount: 5 }),
    e => e instanceof GameError && e.code === 'tram-content')
  const none = createCore(undefined, undefined, { tramContent: { periods: new Map(), hints: tramFixture.hints } })
  assert.throws(() => none.createRoom({ name: 'T', mode: 'tram', teamCount: 3 }),
    e => e instanceof GameError && e.code === 'tram-content')
})

// Dựng phòng tram: team đứng ở `from` đã có tem (không qua ownership)
function tramAt(from, teamCount = 2) {
  const g = setupGame({ mode: 'tram', teamCount })
  g.db.exec('DELETE FROM stamps')
  for (const t of g.teams) {
    placeTeam(g.db, t.id, from)
    g.db.prepare('INSERT INTO stamps (room_id, team_id, province_id, first, question_id, at) VALUES (?, ?, ?, 0, NULL, 0)').run(g.room.roomId, t.id, from)
  }
  g.pts = id => g.db.prepare('SELECT points FROM provinces WHERE id = ?').get(id).points
  g.bonus = id => g.db.prepare('SELECT bonus_points b FROM teams WHERE id = ?').get(id).b
  return g
}
const scoreOf = (g, id) => g.game.scores().find(s => s.teamId === id)

test('tram: đi tới tỉnh, trả lời đúng -> có tem + điểm tỉnh; quay lại tỉnh đã có tem thì đi qua', () => {
  const g = tramAt('hue')
  const t = g.teams[0].id
  const { question } = g.game.move(t, 'quang-tri')
  g.game.answer(t, question.id, correctAnswer(g.db, t))
  assert.equal(scoreOf(g, t).base, g.pts('hue') + g.pts('quang-tri'))
  g.now.advance(60_000)
  assert.equal(g.game.move(t, 'hue').status, 'own')
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM ownership WHERE room_id = ?').get(g.room.roomId).n, 0)
})

test('tram: thành phố không rơi thẻ, không chuỗi thẻ, không siêu tốc, sai chỉ khóa 30 giây', () => {
  const g = tramAt('hue')
  const t = g.teams[0].id
  const { question } = g.game.move(t, 'da-nang')
  g.now.advance(1000)
  const r = g.game.answer(t, question.id, correctAnswer(g.db, t))
  assert.equal(r.card, null)
  assert.equal(r.speedBonus, 0)
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM cards WHERE team_id = ?').get(t).n, 0)
  assert.equal(r.home ?? null, null)
  // 3 câu đúng liên tiếp: không thẻ, không +50
  const g2 = tramAt('hue')
  const u = g2.teams[0].id
  let streak
  for (const to of ['quang-tri', 'ha-tinh', 'nghe-an']) {
    const { question: qq } = g2.game.move(u, to)
    streak = g2.game.answer(u, qq.id, correctAnswer(g2.db, u)).streak
    g2.now.advance(60_000)
  }
  assert.equal(streak.n, 3)
  assert.equal(streak.card, null)
  assert.equal(streak.bonus, 0)
  assert.equal(g2.db.prepare('SELECT COUNT(*) n FROM cards WHERE team_id = ?').get(u).n, 0)
  // sai: khóa đúng 30 giây, không khóa thêm vì cược
  const g3 = tramAt('hue')
  const w = g3.teams[0].id
  const { question: wq } = g3.game.move(w, 'quang-tri')
  const before = g3.bonus(w)
  const res = g3.game.answer(w, wq.id, wrongAnswer(g3.db, w))
  assert.equal(res.lockedUntil - g3.now(), 30_000)
  assert.equal(g3.bonus(w), before)
})

test('tram: hai team cùng có tem một tỉnh (không tranh tỉnh)', () => {
  const g = tramAt('hue')
  for (const { id } of g.teams) {
    const { question } = g.game.move(id, 'quang-tri')
    assert.equal(question !== undefined, true)
    assert.equal(g.game.answer(id, question.id, correctAnswer(g.db, id)).captured, true)
  }
  assert.equal(scoreOf(g, g.teams[0].id).base, scoreOf(g, g.teams[1].id).base)
})

// ---------- Bắt đầu trận: thời kỳ, rải key, mảnh ghép ----------
test('placeKeys: 200 seed — đủ n, không trùng, không phải start/kề start; mỗi miền ≥ 1, không hai key kề', () => {
  const { core } = setupGame({ start: false })
  const { provinces, adjacency } = core
  const eligible = [...tramFixture.hints.keys()]
  const ids = [...provinces.keys()]
  for (let seed = 1; seed <= 200; seed++) {
    const start = ids[seed % ids.length]
    const keys = placeKeys(start, 5, eligible, { provinces, adjacency, random: seededRandom(seed) })
    assert.equal(keys.length, 5)
    assert.equal(new Set(keys).size, 5)
    for (const k of keys) {
      assert.notEqual(k, start)
      assert.ok(!adjacency.get(start).has(k))
      assert.ok(eligible.includes(k))
    }
    assert.equal(new Set(keys.map(k => provinces.get(k).region)).size, 3)
    for (const a of keys) for (const b of keys) assert.ok(a === b || !adjacency.get(a).has(b))
  }
})

test('placeKeys: ít ứng viên vẫn đủ n (hạ ràng buộc)', () => {
  const { core } = setupGame({ start: false })
  const { provinces, adjacency } = core
  const eligible = [...provinces.keys()].slice(0, 8)
  const keys = placeKeys('ha-noi', 5, eligible, { provinces, adjacency, random: seededRandom(1) })
  assert.equal(keys.length, 5)
  assert.equal(new Set(keys).size, 5)
})

test('start() phòng tram: mỗi team có thời kỳ, 5 key, mảnh là hoán vị, tem ở tỉnh xuất phát', () => {
  const g = setupGame({ mode: 'tram', teamCount: 3, start: false })
  assert.equal(g.db.prepare('SELECT tram FROM teams WHERE room_id = ?').get(g.room.roomId).tram, null)
  g.game.start()
  for (const { id } of g.teams) {
    const row = g.db.prepare('SELECT tram, current_province FROM teams WHERE id = ?').get(id)
    const st = JSON.parse(row.tram)
    assert.equal(st.need, 5)
    assert.equal(st.keys.length, 5)
    assert.deepEqual(st.keys.map(k => k.piece).sort(), [0, 1, 2, 3, 4])
    assert.equal(st.stage, 'map')
    assert.equal(st.star, 'ready')
    assert.ok(tramFixture.periods.has(st.period))
    assert.ok(st.keys.every(k => k.hint === 0 && !k.found && !g.core.adjacency.get(row.current_province).has(k.province) && k.province !== row.current_province))
    assert.equal(g.db.prepare('SELECT COUNT(*) n FROM stamps WHERE team_id = ? AND province_id = ?').get(id, row.current_province).n, 1)
  }
})

test('reset() phòng tram xóa teams.tram và tem; start() lại rải mới', () => {
  const g = setupGame({ mode: 'tram', teamCount: 2, start: false })
  g.game.start()
  g.game.reset()
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM teams WHERE room_id = ? AND tram IS NOT NULL').get(g.room.roomId).n, 0)
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM stamps WHERE room_id = ?').get(g.room.roomId).n, 0)
  g.game.start()
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM teams WHERE room_id = ? AND tram IS NOT NULL').get(g.room.roomId).n, 2)
})

test('phòng tram: không có sự kiện MC và câu hỏi chung', () => {
  const g = setupGame({ mode: 'tram', teamCount: 2 })
  for (const f of [() => g.game.triggerEvent('rumor'), () => g.game.triggerEvent('golden'), () => g.game.startShared()]) {
    assert.throws(f, e => e instanceof GameError && e.code === 'tram-no-events' && e.status === 409)
  }
})

test('phòng tram: pause/resume chạy được (gọi shift)', () => {
  const g = setupGame({ mode: 'tram', teamCount: 2 })
  g.game.pause()
  g.now.advance(5000)
  g.game.resume()
  assert.equal(g.game.state().status, 'running')
})
