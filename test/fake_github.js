'use strict'

// An in-memory GitHub covering the endpoints the actions call, so they can be
// exercised without a contributor watching.

function makeWorld() {
  return {
    refs: {}, // 'heads/cla-signatures' -> commit sha
    objects: {}, // sha -> { type, data }
    users: {}, // login -> user
    comments: [],
    runs: [], // pull_request_target runs of the workflow, newest first
    reruns: [],
    nextSha: 1,
    nextCommentId: 1,
  }
}

function makeGithub(world, pr = null, commits = []) {
  const err = (status) => Object.assign(new Error(`http ${status}`), { status })
  const sha = () => `sha${world.nextSha++}`

  return {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      actions: {
        listWorkflowRuns: async ({ workflow_id, event, head_sha }) => {
          const runs = world.runs.filter((r) => r.workflow === workflow_id && r.event === event && r.head_sha === head_sha)
          const run = runs[0]
          if (run && run.status === 'in_progress') run.status = 'completed' // finishes while polled
          return { data: { workflow_runs: runs } }
        },
        reRunWorkflow: async ({ run_id }) => { world.reruns.push(run_id); return { data: {} } },
      },
      users: {
        getByUsername: async ({ username }) => {
          const user = world.users[username.toLowerCase()]
          if (!user) throw err(404)
          return { data: user }
        },
      },
      pulls: {
        get: async () => ({ data: pr }),
        listCommits: async () => ({ data: commits }),
      },
      issues: {
        listComments: async () => ({ data: world.comments }),
        createComment: async ({ body }) => {
          world.comments.push({ id: world.nextCommentId++, body, user: { type: 'Bot' } })
          return { data: {} }
        },
        updateComment: async ({ comment_id, body }) => {
          world.comments.find((c) => c.id === comment_id).body = body
          return { data: {} }
        },
      },
      repos: {
        getContent: async ({ path: p, ref }) => {
          const head = world.refs[`heads/${ref}`] || (world.objects[ref] ? ref : null)
          if (!head) throw err(404)
          const tree = world.objects[world.objects[head].data.tree]
          const entry = tree.data.find((e) => e.path === p)
          if (!entry) throw err(404)
          return {
            data: { content: Buffer.from(world.objects[entry.sha].data, 'utf8').toString('base64') },
          }
        },
      },
      git: {
        getRef: async ({ ref }) => {
          if (!world.refs[ref]) throw err(404)
          return { data: { object: { sha: world.refs[ref] } } }
        },
        createRef: async ({ ref, sha: s }) => {
          const key = ref.replace('refs/', '')
          if (world.refs[key]) throw err(422)
          world.refs[key] = s
          return { data: {} }
        },
        updateRef: async ({ ref, sha: s }) => { world.refs[ref] = s; return { data: {} } },
        createBlob: async ({ content }) => {
          const id = sha()
          world.objects[id] = { type: 'blob', data: Buffer.from(content, 'base64').toString('utf8') }
          return { data: { sha: id } }
        },
        createTree: async ({ tree }) => {
          const id = sha()
          world.objects[id] = { type: 'tree', data: tree }
          return { data: { sha: id } }
        },
        createCommit: async ({ tree, parents, message }) => {
          const id = sha()
          world.objects[id] = { type: 'commit', data: { tree, parents, message } }
          return { data: { sha: id } }
        },
      },
    },
  }
}

// Records what the job concluded: `failures` holds every setFailed message.
const makeCore = () => ({
  failures: [],
  info() {},
  setFailed(m) { this.failures.push(m) },
  summary: { addRaw() { return this }, write: async () => {} },
})

const signatures = (world, branch = 'cla-signatures') => {
  const head = world.refs[`heads/${branch}`]
  if (!head) return null
  const tree = world.objects[world.objects[head].data.tree]
  return JSON.parse(world.objects[tree.data[0].sha].data)
}

const STORE = { branch: 'cla-signatures', path: 'signatures/v1/cla.json' }

module.exports = { makeWorld, makeGithub, makeCore, signatures, STORE }
