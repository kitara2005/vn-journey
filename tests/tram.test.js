import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTramContent } from '../server/game/tram-content.js'
import { tramFixture, tramFixtureWith } from './fixtures/tram-content.js'
import { setupGame } from './helpers.js'

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
