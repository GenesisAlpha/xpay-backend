import assert from "node:assert/strict"
import test from "node:test"

import { syncInstagram } from "./profile-sync.ts"

test("persists Instagram in both profile representations used by settings and auth", async () => {
  const writes = []

  await syncInstagram({
    sellerId: "seller-1",
    userId: "user-1",
    instagram: "@koopfy",
    updateSeller: async (id, instagram) => {
      writes.push({ table: "seller_profiles", id, instagram })
      return { error: null }
    },
    updateUser: async (id, instagram) => {
      writes.push({ table: "users", id, instagram })
      return { error: null }
    },
  })

  assert.deepEqual(writes, [
    { table: "seller_profiles", id: "seller-1", instagram: "@koopfy" },
    { table: "users", id: "user-1", instagram: "@koopfy" },
  ])
})

test("surfaces a seller profile persistence failure and skips the user write", async () => {
  let userWriteAttempted = false

  await assert.rejects(syncInstagram({
    sellerId: "seller-1",
    userId: "user-1",
    instagram: "@koopfy",
    updateSeller: async () => ({ error: { message: "seller write failed" } }),
    updateUser: async () => {
      userWriteAttempted = true
      return { error: null }
    },
  }), /seller write failed/)

  assert.equal(userWriteAttempted, false)
})

test("surfaces a user persistence failure so the modal does not report success", async () => {
  await assert.rejects(syncInstagram({
    sellerId: "seller-1",
    userId: "user-1",
    instagram: "@koopfy",
    updateSeller: async () => ({ error: null }),
    updateUser: async () => ({ error: { message: "user write failed" } }),
  }), /user write failed/)
})
