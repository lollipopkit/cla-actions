'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { run } = require('../src/check')
const { makeWorld, makeGithub, quiet, signatures, STORE } = require('./fake_github')

const OPTS = { document: 'CLA.md', translation: 'CLA_zh.md', note: '', allowlist: ['lollipopkit'], ...STORE }

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

const onPr = (world, pr, commits, opts = OPTS) =>
  run({ github: makeGithub(world, pr, commits), context: ctx('pull_request_target', { pull_request: pr }), core: quiet }, opts)

const onComment = (world, pr, commits, body, user) =>
  run({
    github: makeGithub(world, pr, commits),
    context: ctx('issue_comment', { issue: { number: pr.number, pull_request: {} }, comment: { body, user } }),
    core: quiet,
  }, OPTS)

const status = (w) => w.statuses[w.statuses.length - 1]
const comment = (w) => (w.comments.length ? w.comments[w.comments.length - 1].body : '')
const fresh = (w) => ({ ...w, comments: [], statuses: [] })

// Alice opens #1 unsigned, then signs on it. Later tests start from here.
const signed = makeWorld()
const pr1 = openPr(alice, 1)

test('an unsigned contributor opens a pull request', async () => {
  await onPr(signed, pr1, [commitBy(alice)])
  assert.equal(status(signed).state, 'failure')
  assert.match(status(signed).description, /Alice/)
  assert.match(comment(signed), /CLA signature required/)
  assert.match(comment(signed), /@Alice/)
  assert.match(comment(signed), /blob\/main\/CLA\.md\) \(\[中文\]\(https:\/\/github\.com\/lollipopkit\/demo\/blob\/main\/CLA_zh\.md\)\)/)
  assert.equal(signed.refs['heads/cla-signatures'], undefined)
})

test('she signs', async () => {
  await onComment(signed, pr1, [commitBy(alice)], SENTENCE, alice)
  assert.equal(status(signed).state, 'success')
  const head = signed.refs['heads/cla-signatures']
  assert.ok(head)
  assert.equal(signed.objects[head].data.parents.length, 0, 'first commit is an orphan')
  const sigs = signatures(signed).signatures
  assert.equal(sigs.length, 1)
  assert.deepEqual([sigs[0].login, sigs[0].id, sigs[0].pullRequest], ['Alice', 101, 1])
  assert.equal(signed.comments.length, 1, 'comment rewritten, not duplicated')
  assert.match(comment(signed), /CLA signed/)
})

test('her next pull request passes with no comment', async () => {
  const w = fresh(signed)
  await onPr(w, openPr(alice, 2), [commitBy(alice)])
  assert.equal(status(w).state, 'success')
  assert.equal(w.comments.length, 0)
})

test('an unsigned co-author on a signed contributor’s pull request', async () => {
  const w = fresh(signed)
  await onPr(w, pr1, [commitBy(alice), commitBy(bob)])
  assert.equal(status(w).state, 'failure')
  assert.match(status(w).description, /bob/)
  assert.doesNotMatch(status(w).description, /Alice/)
})

test('someone else posting the sentence signs for nobody', async () => {
  const w = makeWorld()
  await onComment(w, openPr(alice, 4), [commitBy(alice)], SENTENCE, bob)
  assert.equal(w.refs['heads/cla-signatures'], undefined)
  assert.equal(status(w).state, 'failure')
})

test('the allowlist and bots need not sign', async () => {
  const w = makeWorld()
  await onPr(w, openPr(maintainer, 5), [commitBy(maintainer), commitBy(dependabot)])
  assert.equal(status(w).state, 'success')
  assert.equal(w.comments.length, 0)
})

test('a login off the allowlist must sign', async () => {
  const w = makeWorld()
  await onPr(w, openPr(maintainer, 5), [commitBy(maintainer)], { ...OPTS, allowlist: [] })
  assert.equal(status(w).state, 'failure')
})

test('a coding agent committing through a User account', async () => {
  const w = fresh(signed)
  await onPr(w, openPr(alice, 13), [commitBy(alice), commitBy(cursorAgent)])
  assert.equal(status(w).state, 'success')
  const w2 = fresh(signed)
  await onPr(w2, openPr(alice, 14), [commitBy({ ...cursorAgent, id: 778 })])
  assert.equal(status(w2).state, 'failure', 'its login on another account must sign')
})

test('a commit whose author is not a GitHub account', async () => {
  const w = makeWorld()
  await onPr(w, openPr(maintainer, 6), [{ author: null, commit: { author: { name: 'Ghost', email: 'ghost@nowhere' } } }])
  assert.equal(status(w).state, 'failure')
  assert.match(comment(w), /Ghost <ghost@nowhere>/)
  assert.match(comment(w), /github\.com\/settings\/emails/)
})

test('the sentence quoted inside a longer comment is not a signature', async () => {
  const w = makeWorld()
  await onComment(w, openPr(alice, 7), [commitBy(alice)], `do I just write > ${SENTENCE} ?`, alice)
  assert.equal(w.refs['heads/cla-signatures'], undefined)
  assert.equal(w.statuses.length, 0)
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
  const w = fresh(signed)
  const impostor = { login: 'alice', id: 777, type: 'User' }
  await onPr(w, openPr(impostor, 10), [commitBy(impostor)])
  assert.equal(status(w).state, 'failure')
})

test('recheck on a fully signed pull request passes', async () => {
  const w = fresh(signed)
  await onComment(w, openPr(alice, 11), [commitBy(alice)], 'recheck', bob)
  assert.equal(status(w).state, 'success')
})

test('a closed pull request is left alone', async () => {
  const w = makeWorld()
  await onPr(w, { ...openPr(alice, 12), state: 'closed' }, [commitBy(alice)])
  assert.equal(w.statuses.length + w.comments.length, 0)
})

test('the note and an omitted translation', async () => {
  const w = makeWorld()
  await onPr(w, openPr(alice, 15), [commitBy(alice)], { ...OPTS, translation: '', note: 'You keep the copyright.' })
  assert.match(comment(w), /\(https:\/\/github\.com\/lollipopkit\/demo\/blob\/main\/CLA\.md\)\. You keep the copyright\./)
  assert.doesNotMatch(comment(w), /中文/)
})
