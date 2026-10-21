'use strict'

const { createStore } = require('./store')

const SIGN_RE = /^i have read the cla document and i hereby sign the cla\.?$/i
const RECHECK_RE = /^recheck\.?$/i
const STATUS_CONTEXT = 'CLA'
const MARKER = '<!-- cla-check -->'
// GitHub's own committer identity, for commits made in the web UI.
const ALWAYS_ALLOWED = ['web-flow']
// Coding agents that commit through ordinary `User` accounts, so the bot filter
// misses them. Matched by id, since logins can be renamed and reused. The human
// who drives the agent still signs as the pull request's opener.
const AGENT_IDS = new Set([
  199161495, // cursoragent (Cursor Agent, cursoragent@cursor.com)
  81847, // claude (Claude Code, noreply@anthropic.com)
  267193182, // codex (OpenAI Codex)
])

// Checks that everyone who authored a commit in a pull request has signed, and
// records a signature given as a comment on it.
//
// Runs on `pull_request_target` / `issue_comment`, holding a write token while a
// fork's pull request is in play: everything goes through the GitHub API, and
// nothing here checks out or executes repository content.
async function run({ github, context, core }, opts) {
  const { owner, repo } = context.repo
  const allowlist = new Set([...ALWAYS_ALLOWED, ...opts.allowlist].map((l) => l.toLowerCase()))

  const isComment = context.eventName === 'issue_comment'
  const prNumber = isComment ? context.payload.issue.number : context.payload.pull_request.number

  // A comment is a signature only if its entire body is the sentence, so a
  // quoted or discussed sentence does not count as one.
  let signingUser = null
  if (isComment) {
    const author = context.payload.comment.user
    const body = (context.payload.comment.body || '').replace(/\s+/g, ' ').trim()
    if (SIGN_RE.test(body)) {
      if (author.type === 'Bot') return core.info('Ignoring signature from a bot.')
      signingUser = author
    } else if (!RECHECK_RE.test(body)) {
      return core.info('Comment is neither a signature nor a recheck.')
    }
  }

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber })
  if (pr.state !== 'open') return core.info('Pull request is not open.')
  const headSha = pr.head.sha

  const docUrl = (file) => `https://github.com/${owner}/${repo}/blob/${pr.base.repo.default_branch}/${file}`
  const claUrl = docUrl(opts.document)
  const claLink = `[Contributor License Agreement](${claUrl})` +
    (opts.translation ? ` ([中文](${docUrl(opts.translation)}))` : '')

  // --- who has to sign -----------------------------------------------------
  // The commit authors, plus whoever opened the pull request. Commit author
  // metadata is self-reported, so without the opener someone could open a pull
  // request carrying commits attributed to a contributor who has already signed.
  const required = new Map() // login (lowercased) -> { login, id }
  const unlinked = new Set() // commit identities with no GitHub account

  const addRequired = (user) => {
    if (!user || !user.login) return
    if (user.type === 'Bot' || user.login.endsWith('[bot]')) return
    if (AGENT_IDS.has(user.id)) return
    if (allowlist.has(user.login.toLowerCase())) return
    required.set(user.login.toLowerCase(), { login: user.login, id: user.id })
  }

  addRequired(pr.user)
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner, repo, pull_number: prNumber, per_page: 100,
  })
  for (const c of commits) {
    if (c.author) addRequired(c.author)
    else unlinked.add(`${c.commit.author.name} <${c.commit.author.email}>`)
  }

  // --- signatures ----------------------------------------------------------
  const store = createStore({ github, owner, repo, branch: opts.branch, path: opts.path, core })
  let doc = await store.read(opts.branch)
  // Match on id as well as login: logins can be renamed and reused, and a
  // signature belongs to the account that gave it.
  const hasSigned = (user) => {
    const found = doc.signatures.find((s) => s.login.toLowerCase() === user.login.toLowerCase())
    return !!found && found.id === user.id
  }

  if (signingUser) {
    const entry = required.get(signingUser.login.toLowerCase())
    if (!entry) {
      core.info(`${signingUser.login} is not a contributor to this pull request; ignoring.`)
    } else if (hasSigned(entry)) {
      core.info(`${signingUser.login} had already signed.`)
    } else {
      const record = {
        login: signingUser.login,
        id: signingUser.id,
        pullRequest: prNumber,
        commit: headSha,
        signedAt: new Date().toISOString(),
      }
      ;({ doc } = await store.append(record, `chore: ${record.login} signed the CLA (#${prNumber})`))
      core.info(`Recorded signature for ${record.login}.`)
    }
  }

  const pending = [...required.values()].filter((u) => !hasSigned(u))
  const ok = pending.length === 0 && unlinked.size === 0

  // --- report --------------------------------------------------------------
  async function upsertComment(body, createIfMissing) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner, repo, issue_number: prNumber, per_page: 100,
    })
    const existing = comments.find((c) => c.body && c.body.includes(MARKER))
    if (existing) {
      if (existing.body.trim() !== body.trim()) {
        await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
      }
    } else if (createIfMissing) {
      await github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })
    }
  }

  if (ok) {
    await upsertComment(
      `${MARKER}\n### CLA signed\n\n` +
      `Everyone who authored a commit here has signed the ` +
      `[Contributor License Agreement](${claUrl}). Thank you.`,
      false,
    )
  } else {
    const lines = [
      MARKER,
      '### CLA signature required',
      '',
      'Thanks for the pull request. Before it can be merged, everyone who authored a commit',
      `here needs to sign the ${claLink}.${opts.note ? ` ${opts.note}` : ''}`,
      '',
    ]
    if (pending.length) {
      lines.push(
        `**Not signed yet:** ${pending.map((u) => `@${u.login}`).join(', ')}`,
        '',
        'If that is you, read the agreement and post this as a comment on this pull request:',
        '',
        '> I have read the CLA Document and I hereby sign the CLA',
        '',
        'You sign once. It covers everything you contribute to this project afterwards.',
        '',
      )
    }
    if (unlinked.size) {
      lines.push(
        '**Commits whose author is not a GitHub account:**',
        '',
        ...[...unlinked].map((id) => `- \`${id}\``),
        '',
        'These were committed with an email address that is not attached to any GitHub',
        'account, so there is no way to tell who signs for them. Add the address at',
        '<https://github.com/settings/emails> — it can stay private — then comment `recheck`.',
        '',
      )
    }
    lines.push('Comment `recheck` to run this check again.')
    await upsertComment(lines.join('\n'), true)
  }

  const description = ok
    ? 'All contributors have signed the CLA'
    : (pending.length
        ? `Not signed by: ${pending.map((u) => u.login).join(', ')}`
        : 'Some commits have an unrecognised author'
      ).slice(0, 140)

  await github.rest.repos.createCommitStatus({
    owner, repo,
    sha: headSha,
    state: ok ? 'success' : 'failure',
    context: STATUS_CONTEXT,
    description,
    target_url: claUrl,
  })

  if (!ok) core.setFailed(description)
}

module.exports = { run }
