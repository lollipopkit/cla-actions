'use strict'

// Runs the `script:` of each action.yml the way github-script does, so a wrong
// path or option name in the wiring fails here rather than on a pull request.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { makeWorld, makeGithub, quiet, signatures } = require('./fake_github')

const ROOT = path.join(__dirname, '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function script(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((l) => /^\s*script:\s*\|\s*$/.test(l))
  const indent = lines[start + 1].match(/^ */)[0].length
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^ */)[0].length < indent) break
    body.push(line.slice(indent))
  }
  return new AsyncFunction('github', 'context', 'core', 'require', body.join('\n'))
}

function withEnv(env, fn) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  return fn().finally(() => { process.env = saved })
}

test('check action', async () => {
  const w = makeWorld()
  const alice = { login: 'Alice', id: 101, type: 'User' }
  const pr = { state: 'open', user: alice, number: 1, head: { sha: 'h' }, base: { repo: { default_branch: 'main' } } }
  await withEnv({
    CLA_ACTION_PATH: ROOT, CLA_DOCUMENT: 'CLA.md', CLA_TRANSLATION: '', CLA_NOTE: 'n',
    CLA_ALLOWLIST: 'lollipopkit, other', CLA_BRANCH: 'cla-signatures', CLA_PATH: 'signatures/v1/cla.json',
  }, () => script(path.join(ROOT, 'action.yml'))(
    makeGithub(w, pr, []),
    { eventName: 'pull_request_target', payload: { pull_request: pr }, repo: { owner: 'o', repo: 'r' } },
    quiet,
    require,
  ))
  assert.equal(w.statuses[0].state, 'failure')
  assert.match(w.statuses[0].target_url, /\/o\/r\/blob\/main\/CLA\.md$/)
})

test('record action', async () => {
  const w = makeWorld()
  w.users.alice = { login: 'Alice', id: 101 }
  await withEnv({
    CLA_ACTION_PATH: path.join(ROOT, 'record'), CLA_LOGIN: 'alice', CLA_REFERENCE: 'https://github.com/o/r/issues/1',
    CLA_BRANCH: 'cla-signatures', CLA_PATH: 'signatures/v1/cla.json',
  }, () => script(path.join(ROOT, 'record', 'action.yml'))(
    makeGithub(w), { actor: 'o', repo: { owner: 'o', repo: 'r' } }, quiet, require,
  ))
  assert.equal(signatures(w).signatures[0].id, 101)
})
