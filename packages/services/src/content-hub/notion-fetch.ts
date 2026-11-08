// Bounded recursive retrieval of a Notion page's blocks (one level per call, paginated). Depth, total blocks and
// total list calls are capped; whatever is not fetched is disclosed (incomplete + warnings), never silently dropped.
import { LIMITS } from './config.js';
import { blockChildren, type NotionSession } from './notion.js';
import type { TreeNode } from './notion-parse.js';
import type { Warnings } from './normalize.js';

export interface FetchedTree { nodes: TreeNode[]; incomplete: boolean; calls: number; blocks: number }

export async function fetchNotionTree(s: NotionSession, rootId: string, w: Warnings, limits = { maxDepth: LIMITS.notionMaxDepth, maxBlocks: LIMITS.notionMaxBlocks, maxCalls: LIMITS.notionMaxPages }): Promise<FetchedTree> {
  const state = { calls: 0, blocks: 0, incomplete: false };
  const children = async (id: string, depth: number): Promise<TreeNode[]> => {
    const out: TreeNode[] = [];
    let cursor: string | null = null;
    do {
      if (state.calls >= limits.maxCalls || state.blocks >= limits.maxBlocks) {
        state.incomplete = true;
        w.add('page_limit', `Only the first ${limits.maxBlocks} blocks / ${limits.maxCalls} pages of blocks are read per import. The rest was not imported.`);
        return out;
      }
      state.calls++;
      const page = await blockChildren(s, id, cursor);
      for (const b of page.results) {
        state.blocks++;
        out.push(b as TreeNode);
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    for (const node of out) {
      // child_page / child_database are separate objects: never followed.
      if (!node.has_children || node.type === 'child_page' || node.type === 'child_database') continue;
      if (depth + 1 >= limits.maxDepth) {
        state.incomplete = true;
        w.add('depth_limit', `Content nested deeper than ${limits.maxDepth} levels was not imported.`);
        continue;
      }
      node.children = await children(node.id, depth + 1);
    }
    return out;
  };
  const nodes = await children(rootId, 0);
  if (state.incomplete) w.add('incomplete_fetch', 'This import is incomplete: part of the page could not be read within the limits.');
  return { nodes, incomplete: state.incomplete, calls: state.calls, blocks: state.blocks };
}
