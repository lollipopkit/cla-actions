'use strict'

// Signatures live in one JSON file on an orphan branch that holds nothing else.
// Both the check and the record action write through this module, so the file
// format has exactly one definition.

const emptyDoc = () => ({ version: 1, signatures: [] })

function createStore({ github, owner, repo, branch, path, core }) {
  async function read(ref) {
    try {
      const { data } = await github.rest.repos.getContent({ owner, repo, path, ref })
      const doc = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'))
      if (!Array.isArray(doc.signatures)) throw new Error('malformed signature file')
      return doc
    } catch (e) {
      if (e.status === 404) return emptyDoc()
      throw e
    }
  }

  async function head() {
    try {
      const { data } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
      return data.object.sha
    } catch (e) {
      if (e.status === 404) return null
      throw e
    }
  }

  // Writes through the git data API rather than the contents API so the branch
  // can be an orphan. Retries because two signatures can land at the same moment.
  // Returns the document as written and whether this call added the record.
  async function append(record, message) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const parent = await head()
      const doc = parent ? await read(parent) : emptyDoc()
      if (doc.signatures.some((s) => s.id === record.id)) return { doc, added: false }

      doc.signatures.push(record)
      doc.signatures.sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()))

      const { data: blob } = await github.rest.git.createBlob({
        owner, repo,
        content: Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8').toString('base64'),
        encoding: 'base64',
      })
      // No base_tree: the tree is exactly this one file.
      const { data: tree } = await github.rest.git.createTree({
        owner, repo,
        tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
      })
      const { data: commit } = await github.rest.git.createCommit({
        owner, repo, message, tree: tree.sha, parents: parent ? [parent] : [],
      })

      try {
        if (parent) {
          await github.rest.git.updateRef({
            owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: false,
          })
        } else {
          await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha })
        }
        return { doc, added: true }
      } catch (e) {
        if (attempt === 3) throw e
        core.info(`Signature branch moved; retrying (${attempt}/3).`)
      }
    }
  }

  return { read, head, append }
}

module.exports = { createStore }
