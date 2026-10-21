'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { run } = require('../src/check')
const { makeWorld, makeGithub, makeCore, signatures, STORE } = require('./fake_github')

const OPTS = {
  document: 'CLA.md', translation: 'CLA_zh.md', note: '', allowlist: ['lollipopkit'],
  workflow: 'cla.yml', pollMs: 0, ...STORE,
}

const ctx = (eventName, payload) => ({ eventName, payload, repo: { owner: 'lollipopkit', repo: 'demo' } })

const alice = { login: 'Alice', id: 101, type: 'User' }
const bob = { login: 'bob', id: 202, type: 'User' }
const maintainer = { login: 'lollipopkit', id: 10864310, type: 'User' }
const dependabot = { login: 'dependabot[bot]', id: 999, type: 'Bot' }
const cursorAgent = { login: 'cursoragent', id: 199161495, type: 'User' }

const SENTENCE = 'I have read the CLA Document and I hereby sign the CLA'

const commitBy = (user) => ({ author: user, commit: { author: { name: user.login, email: 'x@y.z' } } })

const openPr = (user, number) => ({
  state: 'open', user, number, head: { sha: `head${number}` }, base: { repo: { default_branch: 'main' } },
})

// Returns whether the job passed, as its check run would show.
async function onPr(world, pr, commits, opts = OPTS) {
  const core = makeCore()
  await run({ github: makeGithub(world, pr, commits), context: ctx('pull_request_target', { pull_request: pr }), core }, opts)
  world.runs.unshift({ id: world.runs.length + 1, workflow: 'cla.yml', event: 'pull_request_target', head_sha: pr.head.sha, status: 'completed' })
  return core.failures.length === 0
}

async function onComment(world, pr, commits, body, user) {
  const core = makeCore()
  await run({
    github: makeGithub(world, pr, commits),
    context: ctx('issue_comment', { issue: { number: pr.number, pull_request: {} }, comment: { body, user } }),
    core,
  }, OPTS)
  return core
}

const comment = (w) => (w.comments.length ? w.comments[w.comments.length - 1].body : '')
const fresh = (w) => ({ ...w, comments: [], runs: [], reruns: [] })

// Alice opens #1 unsigned, then signs on it. Later tests start from here.
const signed = makeWorld()
const pr1 = openPr(alice, 1)

test('an unsigned contributor opens a pull request', async () => {
  assert.equal(await onPr(signed, pr1, [commitBy(alice)]), false)
  assert.match(comment(signed), /CLA signature required/)
  assert.match(comment(signed), /@Alice/)
  assert.match(comment(signed), /blob\/main\/CLA\.md\) \(\[中文\]\(https:\/\/github\.com\/lollipopkit\/demo\/blob\/main\/CLA_zh\.md\)\)/)
  assert.equal(signed.refs['heads/cla-signatures'], undefined)
})

test('she signs, and the check is re-run', async () => {
  const core = await onComment(signed, pr1, [commitBy(alice)], SENTENCE, alice)
  assert.deepEqual(core.failures, [])
  assert.deepEqual(signed.reruns, [1])
  const head = signed.refs['heads/cla-signatures']
  assert.equal(signed.objects[head].data.parents.length, 0, 'first commit is an orphan')
  const sigs = signatures(signed).signatures
  assert.deepEqual([sigs.length, sigs[0].login, sigs[0].id, sigs[0].pullRequest], [1, 'Alice', 101, 1])
})

test('the re-run passes and rewrites the comment', async () => {
  assert.equal(await onPr(signed, pr1, [commitBy(alice)]), true)
  assert.equal(signed.comments.length, 1, 'comment rewritten, not duplicated')
  assert.match(comment(signed), /CLA signed/)
})

test('her next pull request passes with no comment', async () => {
  const w = fresh(signed)
  assert.equal(await onPr(w, openPr(alice, 2), [commitBy(alice)]), true)
  assert.equal(w.comments.length, 0)
})

test('an unsigned co-author on a signed contributor’s pull request', async () => {
  const w = fresh(signed)
  assert.equal(await onPr(w, pr1, [commitBy(alice), commitBy(bob)]), false)
  assert.match(comment(w), /@bob/)
  assert.doesNotMatch(comment(w), /@Alice/)
})

test('someone else posting the sentence signs for nobody', async () => {
  const w = makeWorld()
  await onComment(w, openPr(alice, 4), [commitBy(alice)], SENTENCE, bob)
  assert.equal(w.refs['heads/cla-signatures'], undefined)
})

test('the allowlist and bots need not sign', async () => {
  const w = makeWorld()
  assert.equal(await onPr(w, openPr(maintainer, 5), [commitBy(maintainer), commitBy(dependabot)]), true)
  assert.equal(w.comments.length, 0)
})

test('a login off the allowlist must sign', async () => {
  assert.equal(await onPr(makeWorld(), openPr(maintainer, 5), [commitBy(maintainer)], { ...OPTS, allowlist: [] }), false)
})

test('a coding agent committing through a User account', async () => {
  assert.equal(await onPr(fresh(signed), openPr(alice, 13), [commitBy(alice), commitBy(cursorAgent)]), true)
  assert.equal(
    await onPr(fresh(signed), openPr(alice, 14), [commitBy({ ...cursorAgent, id: 778 })]), false,
    'its login on another account must sign',
  )
})

test('a commit whose author is not a GitHub account', async () => {
  const w = makeWorld()
  assert.equal(await onPr(w, openPr(maintainer, 6), [{ author: null, commit: { author: { name: 'Ghost', email: 'ghost@nowhere' } } }]), false)
  assert.match(comment(w), /Ghost <ghost@nowhere>/)
  assert.match(comment(w), /github\.com\/settings\/emails/)
})

test('the sentence quoted inside a longer comment does nothing', async () => {
  const w = makeWorld()
  await onComment(w, openPr(alice, 7), [commitBy(alice)], `do I just write > ${SENTENCE} ?`, alice)
  assert.equal(w.refs['heads/cla-signatures'], undefined)
  assert.equal(w.reruns.length, 0)
})

test('the sentence with stray whitespace and a full stop still signs', async () => {
  const w = makeWorld()
  await onComment(w, openPr(alice, 8), [commitBy(alice)], `  ${SENTENCE}.\n`, alice)
  assert.ok(w.refs['heads/cla-signatures'])
})

test('a bot posting the sentence is ignored', async () => {
  const w = makeWorld()
  await onComment(w, openPr(alice, 9), [commitBy(alice)], SENTENCE, dependabot)
  assert.equal(w.refs['heads/cla-signatures'], undefined)
})

test('a recycled login on a different account does not inherit the signature', async () => {
  const impostor = { login: 'alice', id: 777, type: 'User' }
  assert.equal(await onPr(fresh(signed), openPr(impostor, 10), [commitBy(impostor)]), false)
})

test('recheck re-runs the latest check, waiting for one in progress', async () => {
  const w = makeWorld()
  const pr = openPr(alice, 11)
  w.runs = [
    { id: 8, workflow: 'cla.yml', event: 'pull_request_target', head_sha: pr.head.sha, status: 'in_progress' },
    { id: 7, workflow: 'cla.yml', event: 'pull_request_target', head_sha: pr.head.sha, status: 'completed' },
    { id: 9, workflow: 'other.yml', event: 'pull_request_target', head_sha: pr.head.sha, status: 'completed' },
  ]
  await onComment(w, pr, [commitBy(alice)], 'recheck', bob)
  assert.deepEqual(w.reruns, [8])
})

test('recheck with no check on the head commit fails', async () => {
  const core = await onComment(makeWorld(), openPr(alice, 16), [commitBy(alice)], 'recheck', bob)
  assert.match(core.failures[0], /push a commit/)
})

test('a closed pull request is left alone', async () => {
  const w = makeWorld()
  assert.equal(await onPr(w, { ...openPr(alice, 12), state: 'closed' }, [commitBy(alice)]), true)
  assert.equal(w.comments.length, 0)
})

test('the note and an omitted translation', async () => {
  const w = makeWorld()
  await onPr(w, openPr(alice, 15), [commitBy(alice)], { ...OPTS, translation: '', note: 'You keep the copyright.' })
  assert.match(comment(w), /\(https:\/\/github\.com\/lollipopkit\/demo\/blob\/main\/CLA\.md\)\. You keep the copyright\./)
  assert.doesNotMatch(comment(w), /中文/)
})
