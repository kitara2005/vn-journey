import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTramContent } from '../server/game/tram-content.js'
import { tramFixture, tramFixtureWith } from './fixtures/tram-content.js'
import { setupGame, createCore, memoryDb } from './helpers.js'
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
