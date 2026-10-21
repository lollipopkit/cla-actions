'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { run } = require('../src/record')
const check = require('../src/check')
const { makeWorld, makeGithub, makeCore, signatures, STORE } = require('./fake_github')

const context = { actor: 'lollipopkit', repo: { owner: 'lollipopkit', repo: 'demo' } }
const REF = 'https://github.com/lollipopkit/demo/issues/1#issuecomment-1'

const record = (world, login, reference = REF) =>
  run({ github: makeGithub(world), context, core: makeCore() }, { login, reference, ...STORE })

test('records the account id, the reference and who recorded it', async () => {
  const w = makeWorld()
  w.users.alice = { login: 'Alice', id: 101 }
  await record(w, 'alice')
  const [sig] = signatures(w).signatures
  assert.deepEqual([sig.login, sig.id, sig.reference, sig.recordedBy], ['Alice', 101, REF, 'lollipopkit'])
})

test('a second record of the same account writes nothing', async () => {
  const w = makeWorld()
  w.users.alice = { login: 'Alice', id: 101 }
  await record(w, 'alice')
  const head = w.refs['heads/cla-signatures']
  await record(w, 'Alice')
  assert.equal(w.refs['heads/cla-signatures'], head)
})

test('the check accepts a recorded signature', async () => {
  const w = makeWorld()
  const alice = { login: 'Alice', id: 101, type: 'User' }
  w.users.alice = alice
  await record(w, 'alice')
  const pr = { state: 'open', user: alice, number: 1, head: { sha: 'h' }, base: { repo: { default_branch: 'main' } } }
  const core = makeCore()
  await check.run(
    { github: makeGithub(w, pr, [{ author: alice, commit: { author: {} } }]), context: { eventName: 'pull_request_target', payload: { pull_request: pr }, repo: context.repo }, core },
    { document: 'CLA.md', translation: '', note: '', allowlist: [], workflow: 'cla.yml', ...STORE },
  )
  assert.deepEqual(core.failures, [])
})

test('rejects a reference outside github.com and an empty login', async () => {
  const w = makeWorld()
  await assert.rejects(record(w, 'alice', 'https://example.com/x'), /github\.com URL/)
  await assert.rejects(record(w, ' '), /login is empty/)
  assert.equal(w.refs['heads/cla-signatures'], undefined)
})
