'use strict'

const { createStore } = require('./store')

// Records a signature given somewhere other than the pull request — in
// practice, a past contributor agreeing in an issue after being asked. The
// comment at `reference` is the signature; this only writes it down.
async function run({ github, context, core }, opts) {
  const { owner, repo } = context.repo
  const login = (opts.login || '').trim()
  const reference = (opts.reference || '').trim()
  if (!login) throw new Error('login is empty')
  if (!/^https:\/\/github\.com\//.test(reference)) {
    throw new Error(`reference must be a github.com URL, got: ${reference}`)
  }

  // Resolve the account now, so the record holds the numeric id rather than a
  // login that can later be renamed or reused.
  const { data: user } = await github.rest.users.getByUsername({ username: login })

  const store = createStore({ github, owner, repo, branch: opts.branch, path: opts.path, core })
  const record = {
    login: user.login,
    id: user.id,
    reference,
    recordedBy: context.actor,
    signedAt: new Date().toISOString(),
  }
  const { added } = await store.append(
    record,
    `chore: record ${user.login}'s CLA signature\n\nGiven at ${reference}\nRecorded by ${context.actor}`,
  )

  const result = added
    ? `Recorded ${user.login} (id ${user.id}), signed at ${reference}.`
    : `${user.login} (id ${user.id}) had already signed; nothing written.`
  core.info(result)
  await core.summary.addRaw(result).write()
}

module.exports = { run }
