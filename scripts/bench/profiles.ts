// V3.1 benchmark dataset profiles (brief §2). Sizes describe the MEASURED workspace; extra "neighbour" workspaces add
// tenant noise (other tenants' rows in the same tables) so that tenant-leading indexes and scoping are exercised.
// These are fixtures for measurement, not promised capacity.

export type ProfileName = 'small' | 'medium' | 'large';

export interface Profile {
  name: ProfileName;
  /** Measured workspace. */
  brands: number;
  connections: number;
  posts: number;
  /** Neighbour workspaces (each `neighbourScale` × the measured workspace). */
  neighbours: number;
  neighbourScale: number;
  /** Synthetic analytics history in the measured workspace (services/analytics/demo.ts generateLargeHistory). */
  analytics: { days: number; postsPerDay: number; connectionsPerProvider: number };
  /** Due deliveries created for the claim/dispatch scenario. */
  dispatchBacklog: number;
}

export const PROFILES: Record<ProfileName, Profile> = {
  small: { name: 'small', brands: 2, connections: 10, posts: 1_000, neighbours: 2, neighbourScale: 0.5,
    analytics: { days: 90, postsPerDay: 1, connectionsPerProvider: 1 }, dispatchBacklog: 100 },
  medium: { name: 'medium', brands: 20, connections: 100, posts: 50_000, neighbours: 3, neighbourScale: 0.1,
    analytics: { days: 365, postsPerDay: 1, connectionsPerProvider: 1 }, dispatchBacklog: 300 },
  large: { name: 'large', brands: 100, connections: 500, posts: 250_000, neighbours: 4, neighbourScale: 0.05,
    analytics: { days: 365, postsPerDay: 2, connectionsPerProvider: 2 }, dispatchBacklog: 500 },
};
