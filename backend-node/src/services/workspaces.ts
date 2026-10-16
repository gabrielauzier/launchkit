import { randomUUID } from 'node:crypto'
import { and, asc, eq, notInArray } from 'drizzle-orm'
import type { Database } from '../db/client.ts'
import { type User, type Workspace, workspaceMembers, workspaces } from '../db/schema.ts'

export function personalWorkspaceName(language: string | null | undefined): string {
  return language?.toLowerCase().startsWith('pt') ? 'Pessoal' : 'Personal'
}

/**
 * The user's auto-default Personal workspace plus an owner membership. Idempotent: a user who
 * already has a workspace they created and belong to gets the oldest one back.
 */
export async function createPersonalWorkspaceForUser(db: Database, user: User): Promise<Workspace> {
  const [existing] = await db
    .select({ workspace: workspaces })
    .from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, user.id), eq(workspaces.createdByUserId, user.id)))
    .orderBy(asc(workspaces.createdAt))
    .limit(1)
  if (existing) return existing.workspace

  const language = typeof user.preferences?.language === 'string' ? user.preferences.language : null
  const now = new Date()
  const workspace: Workspace = {
    id: randomUUID(),
    name: personalWorkspaceName(language),
    createdByUserId: user.id,
    isArchived: false,
    managedByUserId: null,
    locale: language,
    timezone: null,
    icon: null,
    color: null,
    createdAt: now,
  }
  await db.transaction(async (tx) => {
    await tx.insert(workspaces).values(workspace)
    await tx.insert(workspaceMembers).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      userId: user.id,
      role: 'owner',
      invitedByUserId: null,
      joinedAt: now,
    })
  })
  return workspace
}

export interface WorkspaceWithRole {
  workspace: Workspace
  role: string
}

/**
 * Every workspace the user can access: the ones they belong to (with their membership role)
 * followed by the ones they only manage (role `manager`), each group oldest first.
 */
export async function listWorkspacesFor(db: Database, userId: string): Promise<WorkspaceWithRole[]> {
  const member = await db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.isArchived, false)))
    .orderBy(asc(workspaces.createdAt))

  const seen = member.map((row) => row.workspace.id)
  const managed = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.managedByUserId, userId),
        eq(workspaces.isArchived, false),
        seen.length ? notInArray(workspaces.id, seen) : undefined,
      ),
    )
    .orderBy(asc(workspaces.createdAt))

  return [...member, ...managed.map((workspace) => ({ workspace, role: 'manager' }))]
}
