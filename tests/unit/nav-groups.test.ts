// D28 grouped main nav + D29 role-based phone bottom bar (apps/web/components/shell/nav-config.ts).
import { describe, expect, it } from 'vitest';
import { LEGACY_ACTION_MAP, PRESET_PERMISSIONS, type Action, type Permission, type RolePreset } from '@social-lite/core';
import { NAV, isActive, navFor } from '../../apps/web/components/shell/nav-config';

function access(...roles: RolePreset[]) {
  const held = new Set<Permission>(roles.flatMap((r) => [...PRESET_PERMISSIONS[r]]));
  return {
    canV2: (p: Permission) => held.has(p),
    can: (a: Action) => { const p = LEGACY_ACTION_MAP[a]; return !!p && held.has(p); },
  };
}
const labels = (items: Array<{ label: string }>) => items.map((n) => n.label);

describe('main nav groups (D28)', () => {
  it('owner sees the four groups in order, Connections once and no separate Integrations item', () => {
    const nav = navFor(access('owner'));
    expect(nav.groups.map((g) => [g.label, labels(g.items)])).toEqual([
      ['Publish', ['Overview', 'Planner', 'Create', 'Content library', 'Campaigns', 'Approvals']],
      ['Engage', ['Inbox', 'Listening', 'Assistant']],
      ['Insights', ['Analytics']],
      ['Workspace', ['Tasks', 'Team', 'Connections', 'Settings', 'Help']],
    ]);
    expect(NAV.some((n) => n.label === 'Integrations' || n.href === '/integrations')).toBe(false);
  });

  it('Connections is active on both of its tabs and their deep links', () => {
    const conn = NAV.find((n) => n.label === 'Connections')!;
    for (const p of ['/accounts', '/accounts/health', '/integrations', '/integrations/asana']) expect(isActive(p, conn)).toBe(true);
    expect(isActive('/integrationsx', conn)).toBe(false);
  });

  it('hides items without access and drops empty groups', () => {
    const nav = navFor(access('viewer'));
    expect(nav.groups.map((g) => g.label)).toEqual(['Publish', 'Insights', 'Workspace']);
    expect(labels(nav.groups[0]!.items)).not.toContain('Create');
    expect(labels(nav.groups.flatMap((g) => g.items))).not.toContain('Team');
  });
});

describe('phone bottom bar (D29)', () => {
  it('publishers and approvers keep Overview · Planner · Create · Approvals', () => {
    expect(labels(navFor(access('owner')).bottom)).toEqual(['Overview', 'Planner', 'Create', 'Approvals']);
    expect(labels(navFor(access('editor')).bottom)).toEqual(['Overview', 'Planner', 'Create', 'Approvals']);
    expect(labels(navFor(access('approver')).bottom)).toEqual(['Overview', 'Planner', 'Approvals']); // no Create without drafts.edit
  });

  it('inbox readers without approval rights get Inbox in place of Approvals', () => {
    const nav = navFor(access('brand_manager'));
    expect(labels(nav.bottom)).toEqual(['Overview', 'Planner', 'Create', 'Inbox']);
    expect(labels(nav.more.flatMap((g) => g.items))).toContain('Approvals');
  });

  it('inbox readers who can’t publish (care agents) get Overview · Inbox, the rest under More by group', () => {
    const nav = navFor(access('care_agent'));
    expect(labels(nav.bottom)).toEqual(['Overview', 'Inbox']);
    expect(nav.more.map((g) => g.label)).toEqual(['Publish', 'Engage', 'Insights', 'Workspace']);
    expect(labels(nav.more[0]!.items)).toEqual(['Planner', 'Content library', 'Campaigns', 'Approvals']);
    expect(labels(nav.more.flatMap((g) => g.items))).not.toContain('Inbox');
  });
});
